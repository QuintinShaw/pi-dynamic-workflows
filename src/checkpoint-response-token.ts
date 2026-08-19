import { randomBytes } from "node:crypto";

export const CHECKPOINT_RESPONSE_TOKEN_SERVICE_SYMBOL = Symbol.for(
  "@quintinshaw/pi-dynamic-workflows/checkpoint-response-token-service/v1",
);
export const CHECKPOINT_RESUME_DISPATCH_SERVICE_SYMBOL = Symbol.for(
  "@quintinshaw/pi-dynamic-workflows/checkpoint-resume-dispatch-service/v1",
);
const TOKEN_PREFIX = "wfcr_";

interface RegisteredCheckpointResponse {
  readonly runId: string;
  readonly checkpointId: string;
  readonly serializedResponse: string;
}

export interface CheckpointResponseTokenService {
  register(binding: CheckpointResponseBinding, response: unknown): string;
  resolve(token: string, binding: CheckpointResponseBinding): unknown;
  release(token: string, binding: CheckpointResponseBinding): boolean;
}

export interface CheckpointResponseBinding {
  readonly runId: string;
  readonly checkpointId: string;
}

export interface CheckpointResumeDispatchRequest extends CheckpointResponseBinding {
  readonly action: "resume";
  readonly responseToken: string;
}

export interface CheckpointResumeDispatchService<TResult = unknown> {
  resume(request: CheckpointResumeDispatchRequest): Promise<TResult>;
}

const root = process as typeof process & {
  [CHECKPOINT_RESPONSE_TOKEN_SERVICE_SYMBOL]?: CheckpointResponseTokenService;
  [CHECKPOINT_RESUME_DISPATCH_SERVICE_SYMBOL]?: CheckpointResumeDispatchService;
};
const entries = new Map<string, RegisteredCheckpointResponse>();

const serializeResponse = (response: unknown): string => {
  const serialized = JSON.stringify(response);
  if (serialized === undefined) throw new Error("Checkpoint response must be JSON-serializable");
  return serialized;
};

const service: CheckpointResponseTokenService = root[CHECKPOINT_RESPONSE_TOKEN_SERVICE_SYMBOL] ?? {
  register(binding, response) {
    if (!binding.runId || !binding.checkpointId) throw new Error("Checkpoint response binding is incomplete");
    const token = `${TOKEN_PREFIX}${randomBytes(24).toString("base64url")}`;
    entries.set(token, {
      runId: binding.runId,
      checkpointId: binding.checkpointId,
      serializedResponse: serializeResponse(response),
    });
    return token;
  },
  resolve(token, binding) {
    const entry = entries.get(token);
    if (!entry || entry.runId !== binding.runId || entry.checkpointId !== binding.checkpointId) {
      throw new Error("Checkpoint response token is invalid for this run and checkpoint");
    }
    return JSON.parse(entry.serializedResponse) as unknown;
  },
  release(token, binding) {
    const entry = entries.get(token);
    if (!entry || entry.runId !== binding.runId || entry.checkpointId !== binding.checkpointId) return false;
    return entries.delete(token);
  },
};
root[CHECKPOINT_RESPONSE_TOKEN_SERVICE_SYMBOL] = service;

/**
 * Store a checkpoint response outside the model-visible tool request.
 *
 * The symbol-backed service is process-global so separately resolved package
 * copies and controller extensions share opaque response tokens.
 */
export function registerCheckpointResponse(binding: CheckpointResponseBinding, response: unknown): string {
  return service.register(binding, response);
}

export function resolveCheckpointResponse(token: string, binding: CheckpointResponseBinding): unknown {
  return service.resolve(token, binding);
}

export function releaseCheckpointResponse(token: string, binding: CheckpointResponseBinding): boolean {
  return service.release(token, binding);
}

export function registerCheckpointResumeDispatchService<TResult>(
  dispatch: CheckpointResumeDispatchService<TResult>,
): void {
  root[CHECKPOINT_RESUME_DISPATCH_SERVICE_SYMBOL] = dispatch;
}

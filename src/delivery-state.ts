/** Internal, process-lifetime transport ownership protocol. Never partition by package version. */
import type { AgentSession, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { WorkflowManager } from "./workflow-manager.js";
import type { WorkflowSettings } from "./workflow-settings.js";

export type DeliveryMessage = {
  customType: string;
  content: string;
  display: boolean;
  details?: { deliveryId?: string };
};
export type DeliverySend = (
  message: DeliveryMessage,
  options: { triggerTurn: boolean; deliverAs: "followUp" },
) => unknown;

export interface SessionDeliveryEndpoint {
  sessionId: string;
  ownerVersion: string;
  /** Notification only: callers must not pass a foreign manager into their code. */
  flushPending: (notifiedRunId?: string) => void;
  reportWarning?: (message: string) => void;
  warned?: boolean;
  /** Captured session-stable thenable send; never the shared void runtime sender. */
  send?: DeliverySend;
  loadSettings?: () => WorkflowSettings;
  /** Remains suspended from shutdown until explicit bind/resume. */
  suspended: boolean;
  generation: number;
  /** Only this endpoint's owning implementation may operate on its manager. */
  manager?: WorkflowManager;
}

export interface StealCandidate {
  sendCustomMessage?: DeliverySend;
  isStreaming?: boolean;
  isIdle?: boolean;
  waitForIdle?: () => Promise<void>;
  agent?: { hasQueuedMessages?: () => boolean };
  subscribe?: (
    listener: (event: {
      type?: string;
      message?: { role?: string; customType?: string; details?: unknown };
      followUp?: readonly unknown[];
      steering?: readonly unknown[];
    }) => void,
  ) => () => void;
  sessionManager?: {
    persist?: boolean;
    getSessionId?: () => string;
    getSessionName?: () => string | undefined;
    getEntries?: () => Array<{ type?: string; customType?: string; details?: unknown }>;
    getBranch?: () => Array<{ id?: string; type?: string; customType?: string; details?: unknown }>;
    getSessionFile?: () => string | undefined;
    isPersisted?: () => boolean;
    isSessionOnDisk?: () => boolean;
  };
  _resourceLoader?: { noExtensions?: boolean };
  _bindExtensionCore?: (...args: unknown[]) => unknown;
}

export interface ActiveStreamingWaiter {
  sessionId: string;
  deliveryId: string;
  hasStarted: () => boolean;
  cancel: (error: Error) => void;
}
export interface DeliveryRetry {
  attempt: number;
  generation: number;
  sessionId: string;
  endpoint: SessionDeliveryEndpoint;
  ownerVersion: string;
  timer?: ReturnType<typeof setTimeout>;
}
export type RecoveryContext = { sessionManager?: { getSessionId?: () => string } };
export interface RecoveryCell {
  ownerVersion: string;
  recover: (ctx?: RecoveryContext) => void;
}
export interface CaptureMethodRecord {
  ownerVersion: string;
  capture: (session: StealCandidate, probe?: boolean) => void;
  original: NonNullable<StealCandidate["sendCustomMessage"]> | NonNullable<StealCandidate["_bindExtensionCore"]>;
  wrapper: CaptureMethodRecord["original"];
}
export interface DeliveryState {
  schemaVersion: 1;
  sessionEndpoints: Map<string, SessionDeliveryEndpoint>;
  boundSessionSends: Map<string, DeliverySend>;
  senderVersions: Map<string, string>;
  inFlightDeliveries: Map<
    string,
    { token: number; sessionId: string; endpoint: SessionDeliveryEndpoint; ownerVersion: string }
  >;
  /** Monotonic even during test cleanup: outstanding finalizers must never reuse a token. */
  inFlightSeq: number;
  streamingAckTimeoutMs: number;
  activeStreamingWaiters: Set<ActiveStreamingWaiter>;
  deliveryRetries: Map<string, DeliveryRetry>;
  deliveredAwaitingClear: Map<
    string,
    { deliveryId: string; sessionId: string; generation: number; endpoint: SessionDeliveryEndpoint }
  >;
  /** A successful probe is reusable only with an accessible same-owner captured sender. */
  probedSessionIds: Set<string>;
  hostAgentSession: typeof AgentSession;
  prototypePatches: WeakMap<object, Partial<Record<"sendCustomMessage" | "_bindExtensionCore", CaptureMethodRecord>>>;
  ownedWrappers: WeakMap<object, CaptureMethodRecord>;
  recoveryCells: WeakMap<ExtensionAPI, RecoveryCell>;
  managerVersions: WeakMap<WorkflowManager, string>;
}

const DELIVERY_STATE_KEY = Symbol.for("@quintinshaw/pi-dynamic-workflows:delivery-state");
export const DEFAULT_STREAMING_ACK_TIMEOUT_MS = 60_000;

/** Called during module evaluation, before the extension factory can claim a staged manager. */
export function acquireDeliveryState(fallbackHost: typeof AgentSession): DeliveryState {
  const root = globalThis as typeof globalThis & { [DELIVERY_STATE_KEY]?: unknown };
  const existing = root[DELIVERY_STATE_KEY];
  if (existing !== undefined) {
    const state = existing as DeliveryState | null;
    if (
      state?.schemaVersion !== 1 ||
      !(state.sessionEndpoints instanceof Map) ||
      !(state.boundSessionSends instanceof Map) ||
      !(state.senderVersions instanceof Map) ||
      !(state.inFlightDeliveries instanceof Map) ||
      !(state.activeStreamingWaiters instanceof Set) ||
      !(state.deliveryRetries instanceof Map) ||
      !(state.deliveredAwaitingClear instanceof Map) ||
      !(state.probedSessionIds instanceof Set) ||
      !(state.prototypePatches instanceof WeakMap) ||
      !(state.ownedWrappers instanceof WeakMap) ||
      !(state.recoveryCells instanceof WeakMap) ||
      !(state.managerVersions instanceof WeakMap) ||
      !Number.isSafeInteger(state.inFlightSeq) ||
      state.inFlightSeq < 0 ||
      typeof state.streamingAckTimeoutMs !== "number" ||
      typeof state.hostAgentSession !== "function"
    ) {
      throw new Error(
        "Workflow delivery state protocol is incompatible; restart Pi before loading this extension. Live ownership was not changed.",
      );
    }
    return state;
  }
  const state: DeliveryState = {
    schemaVersion: 1,
    sessionEndpoints: new Map(),
    boundSessionSends: new Map(),
    senderVersions: new Map(),
    inFlightDeliveries: new Map(),
    inFlightSeq: 0,
    streamingAckTimeoutMs: DEFAULT_STREAMING_ACK_TIMEOUT_MS,
    activeStreamingWaiters: new Set(),
    deliveryRetries: new Map(),
    deliveredAwaitingClear: new Map(),
    probedSessionIds: new Set(),
    hostAgentSession: fallbackHost,
    prototypePatches: new WeakMap(),
    ownedWrappers: new WeakMap(),
    recoveryCells: new WeakMap(),
    managerVersions: new WeakMap(),
  };
  root[DELIVERY_STATE_KEY] = state;
  return state;
}

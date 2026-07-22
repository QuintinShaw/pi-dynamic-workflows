/**
 * Per-agent git worktree isolation and retained-worktree ownership.
 * Ordinary isolation is removed by the caller immediately. Retained isolation is
 * registered here behind an opaque, run-scoped handle and removed only by release
 * or root-run terminal cleanup.
 */

import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  type FileHandle,
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  rmdir,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

const exec = promisify(execFile);

export interface WorktreeCleanupMetadataV1 {
  /** Legacy schema retained for safe in-place cleanup upgrades. */
  version: 1;
  gitCommonRoot: string;
  gitDir: string;
  registrationMarker: string;
}

export interface WorktreeCleanupMetadataV2 {
  /** Legacy cloneable schema retained for safe in-place identity upgrades. */
  version: 2;
  registrationMarker: string;
  repoRoot: string;
  worktreePath: string;
  branch: string;
  branchRef: string;
  baseSha: string;
  gitCommonRoot: string;
  gitDir: string;
}

export interface WorktreeFilesystemIdentity {
  /** Decimal device ID captured with bigint stat. */
  dev: string;
  /** Decimal inode captured with bigint stat. */
  ino: string;
}

export interface WorktreeCleanupMetadataV3 {
  /** Prior current schema retained for same-process cleanup only; never freshly adopted. */
  version: 3;
  /** Random token binding this complete record to one issued cleanup identity. */
  registrationMarker: string;
  /** Original canonical repository root. */
  repoRoot: string;
  /** Original canonical worktree checkout path. */
  worktreePath: string;
  /** Original checkout device/inode; never refreshed for current-version cleanup. */
  checkoutIdentity: WorktreeFilesystemIdentity;
  /** Original temporary branch name. */
  branch: string;
  /** Original full temporary branch ref. */
  branchRef: string;
  /** Exact commit from which the worktree was created. */
  baseSha: string;
  /** Original canonical Git common directory. */
  gitCommonRoot: string;
  /** Original canonical per-worktree Git directory. */
  gitDir: string;
}

export type WorktreeCheckoutProof =
  | { kind: "descriptor" }
  | {
      kind: "sentinel";
      fileName: string;
      token: string;
      excludeLeadingNewline: boolean;
      excludeIdentity: WorktreeFilesystemIdentity;
    };

export type WorktreeGitDirectoryProof =
  | { kind: "descriptor" }
  | {
      kind: "sentinel";
      fileName: string;
      token: string;
      identity: WorktreeFilesystemIdentity;
    };

export interface WorktreeCleanupMetadataV4 {
  /** Current schema binds inode metadata to a durable process descriptor or sentinel. */
  version: 4;
  registrationMarker: string;
  repoRoot: string;
  worktreePath: string;
  checkoutIdentity: WorktreeFilesystemIdentity;
  checkoutProof: WorktreeCheckoutProof;
  /** Original per-worktree Git registration directory identity. */
  gitDirIdentity: WorktreeFilesystemIdentity;
  /** Durable ownership proof. Absent only on already-issued v4 compatibility records. */
  gitDirProof?: WorktreeGitDirectoryProof;
  branch: string;
  branchRef: string;
  baseSha: string;
  gitCommonRoot: string;
  gitDir: string;
}

export type WorktreeCleanupMetadata =
  | WorktreeCleanupMetadataV1
  | WorktreeCleanupMetadataV2
  | WorktreeCleanupMetadataV3
  | WorktreeCleanupMetadataV4;

export interface Worktree {
  /** True when a real worktree was created; false means "ran in the shared tree". */
  isolated: boolean;
  /** cwd the agent should run in (worktree path when isolated, else the base cwd). */
  cwd: string;
  branch?: string;
  /** Full temporary branch ref. */
  branchRef?: string;
  /** Exact commit from which the worktree was created. */
  baseSha?: string;
  /** Repo root the worktree was added to (for teardown). */
  repoRoot?: string;
  /**
   * Cloneable low-level identity required by removeWorktree(). Preserve this
   * object unchanged when copying or serializing a Worktree. It is deliberately
   * separate from the opaque high-level WorktreeHandle capability.
   */
  cleanupMetadata?: WorktreeCleanupMetadata;
  /** Why isolation was skipped, when isolated === false. */
  reason?: string;
  /**
   * Bounded recovery diagnostics when creation succeeded but identity
   * finalization and rollback did not. This is recovery metadata, not a
   * reusable retained-worktree capability.
   */
  recoveryFailures?: WorktreeCleanupFailure[];
  /** @internal Root-owned exact identity for terminal retry after creation rollback failed. */
  creationRecoveryWorktree?: Worktree;
  /** @internal Creation-only branch deletion authority retained across terminal retries. */
  creationRollbackExpectedOid?: string;
}

export interface WorktreeIdentity {
  /** Opaque deterministic identity for operator correlation and recovery. */
  recoveryId?: string;
  branchRef: string;
  baseSha: string;
  /** @deprecated Accepted only as untrusted input to the public diagnostic sanitizer. */
  repoRoot?: string;
  /** @deprecated Accepted only as untrusted input to the public diagnostic sanitizer. */
  worktreePath?: string;
}

export type WorktreeCleanupStage =
  | "identity_verification"
  | "worktree_remove"
  | "branch_delete"
  | "cleanup_dispatch"
  | "unknown";

export interface WorktreeCleanupFailure {
  stage: WorktreeCleanupStage;
  message: string;
  identity: WorktreeIdentity;
}

export interface WorktreeOperations {
  createWorktree(baseCwd: string, name: string): Promise<Worktree>;
  removeWorktree(worktree: Worktree): Promise<undefined | WorktreeCleanupFailure[]>;
  /** Terminally release process-local ownership proofs when no retry authority remains. */
  disposeWorktreeProofs?(worktree: Worktree): Promise<void>;
}

declare const WORKTREE_HANDLE_BRAND: unique symbol;
/** Opaque runtime-issued capability. It deliberately contains no path or ref data. */
export type WorktreeHandle = Readonly<{ [WORKTREE_HANDLE_BRAND]: true }>;

export interface RetainedWorktreeResult<T> {
  result: T;
  worktree: WorktreeHandle;
}

export interface RetainedWorktreeLease {
  worktree: Worktree;
  release(): void;
}

interface RetainedEntry {
  handle: WorktreeHandle;
  canonicalIdentity: string;
  worktree: Worktree;
  tail: Promise<void>;
  releaseRequested: boolean;
  released: boolean;
  releasePromise?: Promise<void>;
}

const issuedHandleOwners = new WeakMap<object, symbol>();

/** Durable scalar used in place of runtime-only retained-worktree capabilities. */
export const RETAINED_WORKTREE_PERSISTENCE_MARKER = "[retained-worktree-handle]";
const PERSISTENCE_CIRCULAR_MARKER = "[circular]";
const PERSISTENCE_ACCESSOR_MARKER = "[accessor omitted]";

/**
 * Clone arbitrary persistence input without carrying runtime capabilities into
 * durable state. Capability recognition is registry-backed rather than based on
 * the deliberately empty public shape. Cycles and accessors become inert scalar
 * markers so the clone remains JSON serializable without invoking user code.
 */
export function sanitizeRetainedWorktreeCapabilitiesForPersistence(value: unknown): unknown {
  const ancestors = new WeakSet<object>();
  const visit = (current: unknown): unknown => {
    if ((typeof current !== "object" && typeof current !== "function") || current === null) return current;
    if (issuedHandleOwners.has(current as object)) return RETAINED_WORKTREE_PERSISTENCE_MARKER;
    if (ancestors.has(current as object)) return PERSISTENCE_CIRCULAR_MARKER;

    ancestors.add(current as object);
    try {
      if (Array.isArray(current)) {
        const descriptors = Object.getOwnPropertyDescriptors(current);
        return Array.from({ length: current.length }, (_, index) => {
          const descriptor = descriptors[String(index)];
          if (!descriptor) return null;
          return "value" in descriptor ? visit(descriptor.value) : PERSISTENCE_ACCESSOR_MARKER;
        });
      }
      const objectTag = Object.prototype.toString.call(current);
      if (objectTag === "[object Map]") {
        return Array.from(Map.prototype.entries.call(current) as MapIterator<[unknown, unknown]>, ([key, item]) => [
          visit(key),
          visit(item),
        ]);
      }
      if (objectTag === "[object Set]") {
        return Array.from(Set.prototype.values.call(current) as SetIterator<unknown>, (item) => visit(item));
      }
      if (objectTag === "[object Date]") {
        const timestamp = Date.prototype.getTime.call(current) as number;
        return Number.isNaN(timestamp) ? null : new Date(timestamp).toISOString();
      }

      const clone: Record<string, unknown> = {};
      const descriptors = Object.getOwnPropertyDescriptors(current);
      for (const key of Object.keys(descriptors)) {
        const descriptor = descriptors[key];
        if (!descriptor?.enumerable) continue;
        clone[key] = "value" in descriptor ? visit(descriptor.value) : PERSISTENCE_ACCESSOR_MARKER;
      }
      return clone;
    } catch {
      // Hostile proxies and exotic cross-realm values are never allowed to make
      // a runtime capability durable or break best-effort persistence.
      return "[unserializable value omitted]";
    } finally {
      ancestors.delete(current as object);
    }
  };
  return visit(value);
}

const MAX_WORKTREE_ID_LENGTH = 32;
const WORKTREE_ID_HASH_LENGTH = 10;
const MAX_CLEANUP_DIAGNOSTIC_LENGTH = 1024;
const REGISTRATION_MARKER_FILE = "pi-dynamic-workflows-registration";
const LEGACY_CHECKOUT_SENTINEL_FILE = ".pi-dynamic-workflows-checkout-identity";
const CHECKOUT_SENTINEL_PREFIX = `${LEGACY_CHECKOUT_SENTINEL_FILE}-`;
const GIT_DIRECTORY_SENTINEL_PREFIX = ".pi-dynamic-workflows-registration-identity-";
const DIRECT_CLEANUP_CLAIM_PREFIX = ".pi-dynamic-workflows";
const LEGACY_CHECKOUT_QUARANTINE_ROOT = "pi-dynamic-workflows-checkout-cleanup";
const LEGACY_REGISTRATION_QUARANTINE_ROOT = "pi-dynamic-workflows-cleanup";
const REPOSITORY_OPERATION_LOCK = "pi-dynamic-workflows-operation-lock";
const REPOSITORY_OPERATION_LOCK_TIMEOUT_MS = 500;
const REPOSITORY_OPERATION_LOCK_ACQUISITION_DEADLINE_MS = 30_000;
const REPOSITORY_OPERATION_LOCK_STALE_MS = 30_000;
const REPOSITORY_OPERATION_LOCK_RETRY_MS = 25;
const RUNTIME_WORKTREE_PREFIX = "pi-workflow-checkout-";
const LEGACY_DIRECT_WORKTREE_PREFIX = ".pi-worktree-";
const PENDING_CLEANUP_RECORD_VERSION = 1;
const CREATION_ADVANCED_BRANCH_PRESERVED = "creation rollback preserved advanced temporary branch";

interface RuntimeWorktreeIdentity {
  version: 3 | 4;
  repoRoot: string;
  worktreePath: string;
  checkoutIdentity: FileIdentity;
  checkoutProof?: WorktreeCheckoutProof;
  gitDirIdentity?: FileIdentity;
  gitDirProof?: WorktreeGitDirectoryProof;
  branch: string;
  branchRef: string;
  baseSha: string;
  gitCommonRoot: string;
  gitDir: string;
  marker: string;
}

/** Successful identities are remembered process-locally so cloned repeated cleanup is idempotent. */
const MAX_CLEANED_RUNTIME_WORKTREES = 1024;
const cleanedRuntimeWorktrees = new Set<string>();
/** Non-serializable ownership proofs retained from final creation until successful cleanup. */
const checkoutDirectoryHandles = new Map<string, FileHandle>();
let allocationDescriptorCount = 0;
const gitDirectoryHandles = new Map<string, FileHandle>();
const sentinelExcludeHandles = new Map<string, FileHandle>();
type CreationRegistrationAuthority = "persisted" | "in-memory";
/** Same-object, process-local authority; it cannot be cloned or serialized into cleanup power. */
const creationRecoveryAuthorities = new WeakMap<object, CreationRegistrationAuthority>();

interface RepositoryGitMetadataQueue {
  tail: Promise<void>;
}

/**
 * Git's worktree registry is repository-global. In particular, `git worktree
 * list` can enumerate a registration immediately before another cleanup moves
 * that directory and then fail while opening it. Keep only the destructive
 * registration interval FIFO-serialized per canonical common Git directory;
 * unrelated repositories and the rest of each agent cleanup remain parallel.
 */
const repositoryGitMetadataQueues = new Map<string, RepositoryGitMetadataQueue>();

interface RepositoryOperationLockOwner {
  version: 1;
  token: string;
  pid: number;
  createdAtMs: number;
}

interface RepositoryOperationLockClaim {
  lockPath: string;
  uniquePath: string;
  identity: FileIdentity;
  owner: RepositoryOperationLockOwner;
}

function parseRepositoryOperationLockOwner(contents: string): RepositoryOperationLockOwner {
  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch {
    throw new Error("repository operation lock owner is not valid JSON");
  }
  if (!value || typeof value !== "object") throw new Error("repository operation lock owner is malformed");
  const owner = value as Partial<RepositoryOperationLockOwner>;
  if (
    owner.version !== 1 ||
    typeof owner.token !== "string" ||
    !/^[0-9a-f]{64}$/.test(owner.token) ||
    typeof owner.pid !== "number" ||
    !Number.isSafeInteger(owner.pid) ||
    owner.pid <= 0 ||
    typeof owner.createdAtMs !== "number" ||
    !Number.isSafeInteger(owner.createdAtMs) ||
    owner.createdAtMs <= 0
  ) {
    throw new Error("repository operation lock owner is malformed");
  }
  return owner as RepositoryOperationLockOwner;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function repositoryOperationLockUniquePath(gitCommonRoot: string, token: string): string {
  return join(gitCommonRoot, `.${REPOSITORY_OPERATION_LOCK}-owner-${token}`);
}

async function inspectRepositoryOperationLock(lockPath: string): Promise<RepositoryOperationLockClaim> {
  const lockStats = await lstat(lockPath, { bigint: true });
  if (lockStats.isSymbolicLink() || !lockStats.isFile()) {
    if (lockStats.isDirectory()) {
      throw new Error(
        "legacy repository operation lock directory requires manual removal after verifying no live owner",
      );
    }
    throw new Error("repository operation lock is not a regular owner file");
  }
  const owner = parseRepositoryOperationLockOwner(await readRegistrationFile(lockPath));
  const uniquePath = repositoryOperationLockUniquePath(dirname(lockPath), owner.token);
  const uniqueStats = await lstat(uniquePath, { bigint: true });
  if (
    uniqueStats.isSymbolicLink() ||
    !uniqueStats.isFile() ||
    !hasFileIdentity(uniqueStats, fileIdentity(lockStats)) ||
    (await readRegistrationFile(uniquePath)) !== (await readRegistrationFile(lockPath))
  ) {
    throw new Error("repository operation lock unique owner identity changed");
  }
  return { lockPath, uniquePath, identity: fileIdentity(lockStats), owner };
}

async function verifyRepositoryOperationLockClaim(claim: RepositoryOperationLockClaim): Promise<void> {
  const [lockStats, uniqueStats, lockContents, uniqueContents] = await Promise.all([
    lstat(claim.lockPath, { bigint: true }),
    lstat(claim.uniquePath, { bigint: true }),
    readRegistrationFile(claim.lockPath),
    readRegistrationFile(claim.uniquePath),
  ]);
  const owner = parseRepositoryOperationLockOwner(lockContents);
  if (
    !lockStats.isFile() ||
    lockStats.isSymbolicLink() ||
    !uniqueStats.isFile() ||
    uniqueStats.isSymbolicLink() ||
    !hasFileIdentity(lockStats, claim.identity) ||
    !hasFileIdentity(uniqueStats, claim.identity) ||
    lockContents !== uniqueContents ||
    owner.token !== claim.owner.token ||
    owner.pid !== claim.owner.pid ||
    owner.createdAtMs !== claim.owner.createdAtMs
  ) {
    throw new Error("repository operation lock identity changed");
  }
}

async function removeClaimedRepositoryOperationLock(
  claim: RepositoryOperationLockClaim,
  hooks: WorktreeCleanupTestHooks = {},
): Promise<void> {
  await hooks.beforeRepositoryOperationLockUnlink?.(claim.lockPath, claim.owner.token);
  try {
    await verifyRepositoryOperationLockClaim(claim);
    await unlink(claim.lockPath);
  } finally {
    const [fixedStats, uniqueStats] = await Promise.all([
      lstat(claim.lockPath, { bigint: true }).catch(() => undefined),
      lstat(claim.uniquePath, { bigint: true }).catch(() => undefined),
    ]);
    if (
      uniqueStats?.isFile() &&
      !uniqueStats.isSymbolicLink() &&
      hasFileIdentity(uniqueStats, claim.identity) &&
      (!fixedStats || !hasFileIdentity(fixedStats, claim.identity))
    ) {
      await unlink(claim.uniquePath);
    }
  }
}

async function acquireRepositoryOperationLock(
  gitCommonRoot: string,
  hooks: WorktreeCleanupTestHooks = {},
): Promise<RepositoryOperationLockClaim> {
  const canonicalRoot = await realDirectory(gitCommonRoot, false);
  if (canonicalRoot !== gitCommonRoot) throw new Error("repository operation lock parent is not canonical");
  const lockPath = join(canonicalRoot, REPOSITORY_OPERATION_LOCK);
  const startedAt = Date.now();
  const acquisitionDeadlineMs = Math.max(
    1,
    hooks.repositoryOperationLockAcquisitionDeadlineMs ?? REPOSITORY_OPERATION_LOCK_ACQUISITION_DEADLINE_MS,
  );
  const retryMs = Math.max(1, hooks.repositoryOperationLockRetryMs ?? REPOSITORY_OPERATION_LOCK_RETRY_MS);
  const owner: RepositoryOperationLockOwner = {
    version: 1,
    token: randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", ""),
    pid: process.pid,
    createdAtMs: Date.now(),
  };

  const uniquePath = repositoryOperationLockUniquePath(canonicalRoot, owner.token);
  await writeFile(uniquePath, `${JSON.stringify(owner)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  try {
    const uniqueStats = await lstat(uniquePath, { bigint: true });
    if (uniqueStats.isSymbolicLink() || !uniqueStats.isFile()) {
      throw new Error("repository operation lock unique owner is not a regular file");
    }
    const uniqueIdentity = fileIdentity(uniqueStats);
    while (true) {
      try {
        await link(uniquePath, lockPath);
        const claim = await inspectRepositoryOperationLock(lockPath);
        if (claim.owner.token !== owner.token || !hasFileIdentity(claim.identity, uniqueIdentity)) {
          throw new Error("repository operation lock ownership changed during atomic claim");
        }
        return claim;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        let existing: RepositoryOperationLockClaim;
        try {
          existing = await inspectRepositoryOperationLock(lockPath);
        } catch (inspectionError) {
          if ((inspectionError as NodeJS.ErrnoException).code === "ENOENT") {
            const fixedStillExists = await lstat(lockPath).then(
              () => true,
              (error: NodeJS.ErrnoException) => {
                if (error.code === "ENOENT") return false;
                throw error;
              },
            );
            if (fixedStillExists && Date.now() - startedAt > REPOSITORY_OPERATION_LOCK_TIMEOUT_MS) {
              throw new Error("repository operation lock has no initialized unique owner file");
            }
            await delay(retryMs);
            continue;
          }
          throw inspectionError;
        }
        const age = Date.now() - existing.owner.createdAtMs;
        const ownerAlive = processIsAlive(existing.owner.pid);
        if (!ownerAlive && age >= REPOSITORY_OPERATION_LOCK_STALE_MS) {
          try {
            await removeClaimedRepositoryOperationLock(existing, hooks);
          } catch (reclaimError) {
            const current = await inspectRepositoryOperationLock(lockPath).catch(
              (inspectionError: NodeJS.ErrnoException) => {
                if (inspectionError.code === "ENOENT") return undefined;
                throw reclaimError;
              },
            );
            if (current && hasFileIdentity(current.identity, existing.identity)) throw reclaimError;
            await delay(retryMs);
          }
          continue;
        }
        if (!ownerAlive && Date.now() - startedAt > REPOSITORY_OPERATION_LOCK_TIMEOUT_MS) {
          throw new Error("repository operation lock acquisition timed out");
        }
        if (ownerAlive && Date.now() - startedAt >= acquisitionDeadlineMs) {
          throw new Error("repository operation lock acquisition deadline exceeded for a verified live owner");
        }
        await delay(retryMs);
      }
    }
  } catch (error) {
    const fixedStats = await lstat(lockPath, { bigint: true }).catch(() => undefined);
    const uniqueStats = await lstat(uniquePath, { bigint: true }).catch(() => undefined);
    if (
      fixedStats?.isFile() &&
      uniqueStats?.isFile() &&
      !fixedStats.isSymbolicLink() &&
      !uniqueStats.isSymbolicLink() &&
      hasFileIdentity(fixedStats, fileIdentity(uniqueStats))
    ) {
      await unlink(lockPath).catch(() => undefined);
    }
    await unlink(uniquePath).catch(() => undefined);
    throw error;
  }
}

async function withRepositoryGitMetadataCleanup<T>(
  gitCommonRoot: string,
  operation: () => Promise<T>,
  hooks: WorktreeCleanupTestHooks = {},
): Promise<T> {
  let queue = repositoryGitMetadataQueues.get(gitCommonRoot);
  if (!queue) {
    queue = { tail: Promise.resolve() };
    repositoryGitMetadataQueues.set(gitCommonRoot, queue);
  }

  const previous = queue.tail;
  let releaseTurn!: () => void;
  const turn = new Promise<void>((resolveTurn) => {
    releaseTurn = resolveTurn;
  });
  const completion = previous.then(() => turn);
  queue.tail = completion;

  await previous;
  let lock: RepositoryOperationLockClaim | undefined;
  try {
    lock = await acquireRepositoryOperationLock(gitCommonRoot, hooks);
    return await operation();
  } finally {
    try {
      if (lock) await removeClaimedRepositoryOperationLock(lock, hooks);
    } finally {
      releaseTurn();
      if (queue.tail === completion) repositoryGitMetadataQueues.delete(gitCommonRoot);
    }
  }
}

function rememberCleanedRuntimeWorktree(identityKey: string): void {
  if (cleanedRuntimeWorktrees.has(identityKey)) return;
  cleanedRuntimeWorktrees.add(identityKey);
  if (cleanedRuntimeWorktrees.size <= MAX_CLEANED_RUNTIME_WORKTREES) return;
  const oldest = cleanedRuntimeWorktrees.values().next().value;
  if (oldest !== undefined) cleanedRuntimeWorktrees.delete(oldest);
}

function slug(name: string): string {
  const normalized =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "agent";
  if (normalized.length <= MAX_WORKTREE_ID_LENGTH) return normalized;

  // Keep the readable prefix while reserving room for identity that truncation
  // cannot erase (notably the workflow call index and label).
  const suffix = createHash("sha256").update(name).digest("hex").slice(0, WORKTREE_ID_HASH_LENGTH);
  const prefixLength = MAX_WORKTREE_ID_LENGTH - WORKTREE_ID_HASH_LENGTH - 1;
  const prefix = normalized.slice(0, prefixLength).replace(/-+$/g, "") || "agent";
  return `${prefix}-${suffix}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function redactAbsolutePaths(message: string): string {
  return message
    .replace(/(?:[A-Za-z]:[\\/]|\\\\)[^\s"'`<>{}|]+/g, "<redacted-path>")
    .replace(/(^|[\s"'`(=:[])(\/(?:[^\s"'`<>{}|;,()[\]]+\/?)+)/g, "$1<redacted-path>");
}

function boundedDiagnostic(message: string): string {
  return redactAbsolutePaths(message).slice(0, MAX_CLEANUP_DIAGNOSTIC_LENGTH);
}

function validDiagnosticBranchRef(value: string): boolean {
  return /^refs\/heads\/pi\/wf\/[A-Za-z0-9_-]{1,256}$/.test(value);
}

function validDiagnosticBaseSha(value: string): boolean {
  return /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(value);
}

function opaqueCleanupIdentity(input: WorktreeIdentity): WorktreeIdentity {
  const raw = {
    recoveryId: input.recoveryId,
    repoRoot: input.repoRoot,
    worktreePath: input.worktreePath,
    branchRef: input.branchRef,
    baseSha: input.baseSha,
  };
  const suppliedRecoveryId = typeof input.recoveryId === "string" ? input.recoveryId : "";
  return {
    recoveryId: /^[0-9a-f]{64}$/i.test(suppliedRecoveryId)
      ? suppliedRecoveryId.toLowerCase()
      : createHash("sha256").update(JSON.stringify(raw)).digest("hex"),
    branchRef: validDiagnosticBranchRef(input.branchRef) ? input.branchRef : "<redacted-ref>",
    baseSha: validDiagnosticBaseSha(input.baseSha) ? input.baseSha.toLowerCase() : "<unknown>",
  };
}

/**
 * Synthesize every public/durable cleanup diagnostic exclusively from allowlisted
 * structured fields. Raw filesystem/Git errors are deliberately discarded here:
 * regex path removal cannot safely preserve arbitrary prose.
 */
export function sanitizeWorktreeCleanupFailure(failure: WorktreeCleanupFailure): WorktreeCleanupFailure {
  const identity = opaqueCleanupIdentity(failure.identity);
  const stage: WorktreeCleanupStage = (
    ["identity_verification", "worktree_remove", "branch_delete", "cleanup_dispatch"] as unknown[]
  ).includes(failure.stage)
    ? failure.stage
    : "unknown";
  return {
    stage,
    message: `Worktree cleanup failed at ${stage}; recovery ID ${identity.recoveryId}.`,
    identity,
  };
}

function creationFailureReason(code: string, failures: readonly WorktreeCleanupFailure[] = []): string {
  if (failures.length === 0) return `Worktree creation failed safely (${code}).`;
  const stages = [...new Set(failures.map((failure) => failure.stage))].join(", ");
  const recoveryIds = failures
    .map((failure) => failure.identity.recoveryId)
    .filter(Boolean)
    .join(", ");
  return `Worktree creation failed safely (${code}); ${failures.length} cleanup failure(s) at stage(s): ${stages}; recovery ID(s): ${recoveryIds}.`;
}

async function realDirectory(path: string, create: boolean): Promise<string> {
  if (create) {
    try {
      await mkdir(path, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  const pathStats = await lstat(path);
  if (pathStats.isSymbolicLink()) throw new Error(`refusing symbolic-link directory: ${path}`);
  if (!pathStats.isDirectory()) throw new Error(`expected a real directory: ${path}`);
  const canonicalPath = await realpath(path);
  if (canonicalPath !== path) throw new Error(`directory is not canonical: ${path}`);
  return canonicalPath;
}

async function secureChildDirectory(parent: string, childName: string, create: boolean): Promise<string> {
  const canonicalParent = await realDirectory(parent, false);
  const requestedChild = join(canonicalParent, childName);
  const canonicalChild = await realDirectory(requestedChild, create);
  const containedPath = relative(canonicalParent, canonicalChild);
  if (containedPath !== childName || canonicalChild !== requestedChild) {
    throw new Error(`directory is not an exact child of its canonical parent: ${requestedChild}`);
  }
  return canonicalChild;
}

async function secureWorktreeRoot(repoRoot: string, create: boolean): Promise<string> {
  const canonicalRepoRoot = await realDirectory(repoRoot, false);
  if (canonicalRepoRoot !== repoRoot) throw new Error("repository root is not canonical");
  const piRoot = await secureChildDirectory(canonicalRepoRoot, ".pi", create);
  return secureChildDirectory(piRoot, "worktrees", create);
}

function isExactPrefixedChild(parent: string, childPath: string, prefix: string): boolean {
  const child = relative(parent, childPath);
  return (
    child.length > prefix.length &&
    !child.startsWith("..") &&
    !isAbsolute(child) &&
    !child.includes("/") &&
    !child.includes("\\") &&
    child.startsWith(prefix) &&
    resolve(parent, child) === childPath
  );
}

function isExactRuntimeWorktreeChild(gitCommonRoot: string, worktreePath: string): boolean {
  return isExactPrefixedChild(gitCommonRoot, worktreePath, RUNTIME_WORKTREE_PREFIX);
}

function isExactLegacyDirectWorktreeChild(repoRoot: string, worktreePath: string): boolean {
  return isExactPrefixedChild(repoRoot, worktreePath, LEGACY_DIRECT_WORKTREE_PREFIX);
}

async function verifyRuntimeWorktreeContainment(
  repoRoot: string,
  gitCommonRoot: string,
  worktreePath: string,
): Promise<void> {
  if (isExactRuntimeWorktreeChild(gitCommonRoot, worktreePath)) return;
  if (isExactLegacyDirectWorktreeChild(repoRoot, worktreePath)) return;
  const legacyRoot = await secureWorktreeRoot(repoRoot, false);
  const child = relative(legacyRoot, worktreePath);
  if (
    !child ||
    child.startsWith("..") ||
    isAbsolute(child) ||
    child.includes("/") ||
    child.includes("\\") ||
    resolve(legacyRoot, child) !== worktreePath
  ) {
    throw new Error(
      "runtime worktree path is neither an exact Git-common-dir runtime child nor a trusted legacy worktree child",
    );
  }
}

interface GitExecutionResult {
  stdout: string;
}

type GitExecutor = (args: string[]) => Promise<GitExecutionResult>;

const executeGit: GitExecutor = async (args) => {
  const { stdout } = await exec("git", args);
  return { stdout: String(stdout) };
};

async function resolveGitDirectory(
  commandCwd: string,
  option: "--git-common-dir" | "--git-dir",
  gitExec: GitExecutor = executeGit,
): Promise<string> {
  const { stdout } = await gitExec(["-C", commandCwd, "rev-parse", option]);
  const output = stdout.trim();
  return realpath(isAbsolute(output) ? output : resolve(commandCwd, output));
}

async function secureCleanupClaimParent(expected: RuntimeWorktreeIdentity): Promise<string> {
  const canonicalRepoRoot = await realDirectory(expected.repoRoot, false);
  if (canonicalRepoRoot !== expected.repoRoot) throw new Error("repository root is not canonical");
  const canonicalGitCommonRoot = await realDirectory(expected.gitCommonRoot, false);
  if (canonicalGitCommonRoot !== expected.gitCommonRoot) throw new Error("Git common root is not canonical");
  return canonicalGitCommonRoot;
}

function legacyQuarantineRoot(expected: RuntimeWorktreeIdentity, kind: DirectoryClaimKind): string {
  return join(
    expected.gitCommonRoot,
    kind === "checkout" ? LEGACY_CHECKOUT_QUARANTINE_ROOT : LEGACY_REGISTRATION_QUARANTINE_ROOT,
  );
}

function isCurrentSentinelFileName(fileName: string): boolean {
  return new RegExp(`^${CHECKOUT_SENTINEL_PREFIX.replaceAll(".", "\\.")}[0-9a-f]{64}$`).test(fileName);
}

function sentinelExcludeTag(proof: Extract<WorktreeCheckoutProof, { kind: "sentinel" }>): string {
  const ownership = createHash("sha256").update(`${proof.fileName}\0${proof.token}`).digest("hex");
  return `# pi-dynamic-workflows-owned-sentinel:${ownership}`;
}

function sentinelExcludeBlock(proof: Extract<WorktreeCheckoutProof, { kind: "sentinel" }>): string {
  return `${proof.excludeLeadingNewline ? "\n" : ""}${sentinelExcludeTag(proof)}\n/${proof.fileName}\n`;
}

async function readBoundedFile(handle: FileHandle): Promise<Buffer> {
  const stats = await handle.stat({ bigint: true });
  if (!stats.isFile() || stats.size > 1_048_576n) throw new Error("Git exclude file is not a bounded regular file");
  const size = Number(stats.size);
  const contents = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const { bytesRead } = await handle.read(contents, offset, size - offset, offset);
    if (bytesRead === 0) throw new Error("Git exclude file changed during descriptor read");
    offset += bytesRead;
  }
  return contents;
}

function locateOwnedSentinelBlock(
  contents: Buffer,
  proof: Extract<WorktreeCheckoutProof, { kind: "sentinel" }>,
): { offset: number; block: Buffer } | undefined {
  const block = Buffer.from(sentinelExcludeBlock(proof), "utf8");
  const offset = contents.indexOf(block);
  if (offset < 0) {
    const hasTag = contents.indexOf(Buffer.from(sentinelExcludeTag(proof), "utf8")) >= 0;
    const hasFileName = contents.indexOf(Buffer.from(proof.fileName, "utf8")) >= 0;
    if (!hasTag && !hasFileName) return undefined;
    throw new Error("owned sentinel exclude block is incomplete or changed");
  }
  if (contents.indexOf(block, offset + block.length) >= 0) {
    throw new Error("owned sentinel exclude block is duplicated");
  }
  return { offset, block };
}

function neutralizedSentinelBlock(block: Buffer): Buffer {
  const neutralized = Buffer.alloc(block.length, 0x20);
  let lineStart = true;
  for (let index = 0; index < block.length; index++) {
    if (block[index] === 0x0a) {
      neutralized[index] = 0x0a;
      lineStart = true;
    } else if (lineStart) {
      neutralized[index] = 0x23;
      lineStart = false;
    }
  }
  return neutralized;
}

async function appendSentinelExclude(
  gitCommonRoot: string,
  marker: string,
  proof: Pick<Extract<WorktreeCheckoutProof, { kind: "sentinel" }>, "kind" | "fileName" | "token">,
  repositoryLockHeld = false,
): Promise<Extract<WorktreeCheckoutProof, { kind: "sentinel" }>> {
  const operation = async () => {
    const infoRoot = await secureChildDirectory(gitCommonRoot, "info", true);
    const excludePath = join(infoRoot, "exclude");
    const handle = await open(excludePath, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
    try {
      const [pathStats, handleStats] = await Promise.all([
        lstat(excludePath, { bigint: true }),
        handle.stat({ bigint: true }),
      ]);
      const excludeIdentity = fileIdentity(handleStats);
      if (
        pathStats.isSymbolicLink() ||
        !pathStats.isFile() ||
        !handleStats.isFile() ||
        !hasFileIdentity(pathStats, excludeIdentity)
      ) {
        throw new Error("Git exclude file identity changed during sentinel append");
      }
      const existing = await readBoundedFile(handle);
      const excludeLeadingNewline = existing.length > 0 && existing[existing.length - 1] !== 0x0a;
      const completedProof = { ...proof, excludeLeadingNewline, excludeIdentity };
      const block = Buffer.from(sentinelExcludeBlock(completedProof), "utf8");
      await appendToVerifiedExcludePath(excludePath, excludeIdentity, block, "sentinel append");
      const [finalPathStats, finalHandleStats] = await Promise.all([
        lstat(excludePath, { bigint: true }),
        handle.stat({ bigint: true }),
      ]);
      if (
        finalPathStats.isSymbolicLink() ||
        !finalPathStats.isFile() ||
        !finalHandleStats.isFile() ||
        !hasFileIdentity(finalPathStats, excludeIdentity) ||
        !hasFileIdentity(finalHandleStats, excludeIdentity)
      ) {
        throw new Error("Git exclude file identity changed after sentinel append");
      }
      const previous = sentinelExcludeHandles.get(marker);
      sentinelExcludeHandles.set(marker, handle);
      if (previous && previous !== handle) await previous.close().catch(() => undefined);
      return completedProof;
    } catch (error) {
      await handle.close().catch(() => undefined);
      throw error;
    }
  };
  return repositoryLockHeld ? operation() : withRepositoryGitMetadataCleanup(gitCommonRoot, operation);
}

async function appendToVerifiedExcludePath(
  excludePath: string,
  expectedIdentity: FileIdentity,
  contents: Buffer,
  operation: string,
): Promise<void> {
  const appendHandle = await open(excludePath, constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW);
  try {
    const [pathStats, handleStats] = await Promise.all([
      lstat(excludePath, { bigint: true }),
      appendHandle.stat({ bigint: true }),
    ]);
    if (
      pathStats.isSymbolicLink() ||
      !pathStats.isFile() ||
      !handleStats.isFile() ||
      !hasFileIdentity(pathStats, expectedIdentity) ||
      !hasFileIdentity(handleStats, expectedIdentity)
    ) {
      throw new Error(`Git exclude file identity changed before ${operation}`);
    }
    const { bytesWritten } = await appendHandle.write(contents, 0, contents.length, null);
    if (bytesWritten !== contents.length) throw new Error(`Git exclude ${operation} was incomplete`);
  } finally {
    await appendHandle.close();
  }
}

async function verifiedSentinelExcludeHandle(
  gitCommonRoot: string,
  marker: string,
  proof: Extract<WorktreeCheckoutProof, { kind: "sentinel" }>,
  simulateReusedIdentity = false,
): Promise<{ handle: FileHandle; excludePath: string }> {
  const handle = sentinelExcludeHandles.get(marker);
  if (!handle) throw new Error("process-local Git exclude descriptor is unavailable for current-version cleanup");
  const infoRoot = await secureChildDirectory(gitCommonRoot, "info", false);
  const excludePath = join(infoRoot, "exclude");
  const [pathStats, handleStats] = await Promise.all([
    lstat(excludePath, { bigint: true }),
    handle.stat({ bigint: true }),
  ]);
  if (
    pathStats.isSymbolicLink() ||
    !pathStats.isFile() ||
    !handleStats.isFile() ||
    (!simulateReusedIdentity && !hasFileIdentity(pathStats, proof.excludeIdentity)) ||
    !hasFileIdentity(handleStats, proof.excludeIdentity) ||
    !hasFileIdentity(pathStats, fileIdentity(handleStats))
  ) {
    throw new Error("Git exclude file no longer matches its original descriptor identity");
  }
  return { handle, excludePath };
}

async function restoreSentinelExclude(
  gitCommonRoot: string,
  marker: string,
  proof: Extract<WorktreeCheckoutProof, { kind: "sentinel" }>,
  repositoryLockHeld = false,
): Promise<void> {
  if (!isCurrentSentinelFileName(proof.fileName)) return;
  const operation = async () => {
    const { handle, excludePath } = await verifiedSentinelExcludeHandle(gitCommonRoot, marker, proof);
    const existing = await readBoundedFile(handle);
    if (locateOwnedSentinelBlock(existing, proof)) return;
    const blockBytes = Buffer.from(sentinelExcludeBlock(proof), "utf8");
    await appendToVerifiedExcludePath(excludePath, proof.excludeIdentity, blockBytes, "sentinel restore append");
  };
  if (repositoryLockHeld) await operation();
  else await withRepositoryGitMetadataCleanup(gitCommonRoot, operation);
}

async function removeSentinelExclude(
  gitCommonRoot: string,
  marker: string,
  proof: Extract<WorktreeCheckoutProof, { kind: "sentinel" }>,
  hooks: WorktreeCleanupTestHooks = {},
  repositoryLockHeld = false,
): Promise<void> {
  if (!isCurrentSentinelFileName(proof.fileName)) return;
  const operation = async () => {
    const { handle, excludePath } = await verifiedSentinelExcludeHandle(
      gitCommonRoot,
      marker,
      proof,
      hooks.simulateReusedExcludeIdentity,
    );
    const initial = await readBoundedFile(handle);
    if (!locateOwnedSentinelBlock(initial, proof)) {
      throw new Error("owned sentinel exclude block cannot be uniquely located");
    }
    await hooks.beforeSentinelExcludeNeutralize?.();

    const [currentPathStats, currentHandleStats] = await Promise.all([
      lstat(excludePath, { bigint: true }),
      handle.stat({ bigint: true }),
    ]);
    if (
      currentPathStats.isSymbolicLink() ||
      !currentPathStats.isFile() ||
      !currentHandleStats.isFile() ||
      (!hooks.simulateReusedExcludeIdentity && !hasFileIdentity(currentPathStats, proof.excludeIdentity)) ||
      !hasFileIdentity(currentHandleStats, proof.excludeIdentity) ||
      !hasFileIdentity(currentPathStats, fileIdentity(currentHandleStats))
    ) {
      throw new Error("Git exclude file identity changed before owned block neutralization");
    }
    const fresh = await readBoundedFile(handle);
    const owned = locateOwnedSentinelBlock(fresh, proof);
    if (!owned) throw new Error("owned sentinel exclude block disappeared before neutralization");
    const neutralized = neutralizedSentinelBlock(owned.block);
    const { bytesWritten } = await handle.write(neutralized, 0, neutralized.length, owned.offset);
    if (bytesWritten !== neutralized.length)
      throw new Error("owned sentinel exclude block neutralization was incomplete");
  };
  if (repositoryLockHeld) await operation();
  else await withRepositoryGitMetadataCleanup(gitCommonRoot, operation);
}

async function verifySentinelCheckoutPath(
  worktreePath: string,
  expectedIdentity: FileIdentity,
  requiredHandle?: FileHandle,
): Promise<void> {
  const [pathStats, canonicalPath, handleStats] = await Promise.all([
    lstat(worktreePath, { bigint: true }),
    realpath(worktreePath),
    requiredHandle?.stat({ bigint: true }),
  ]);
  if (
    canonicalPath !== worktreePath ||
    pathStats.isSymbolicLink() ||
    !pathStats.isDirectory() ||
    !hasFileIdentity(pathStats, expectedIdentity) ||
    (requiredHandle !== undefined &&
      (!handleStats?.isDirectory() ||
        !hasFileIdentity(handleStats, expectedIdentity) ||
        !hasFileIdentity(handleStats, fileIdentity(pathStats))))
  ) {
    throw new Error("portable sentinel checkout path does not match its allocated descriptor identity");
  }
}

async function createCheckoutSentinel(
  worktreePath: string,
  gitCommonRoot: string,
  marker: string,
  expectedIdentity: FileIdentity,
  requiredHandle: FileHandle,
  repositoryLockHeld = false,
  writeOptions: DescriptorRelativeWriteOptions = {},
): Promise<WorktreeCheckoutProof> {
  await verifySentinelCheckoutPath(worktreePath, expectedIdentity, requiredHandle);
  const token = randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", "");
  const fileName = `${CHECKOUT_SENTINEL_PREFIX}${randomUUID().replaceAll("-", "")}${randomUUID().replaceAll("-", "")}`;
  const initialProof = { kind: "sentinel", fileName, token } as const;
  const proof = await appendSentinelExclude(gitCommonRoot, marker, initialProof, repositoryLockHeld);
  try {
    await verifySentinelCheckoutPath(worktreePath, expectedIdentity, requiredHandle);
    await writeExclusiveDescriptorRelative(
      worktreePath,
      requiredHandle,
      expectedIdentity,
      fileName,
      `${token}\n`,
      "checkout",
      writeOptions,
    );
    return proof;
  } catch (error) {
    await removeSentinelExclude(gitCommonRoot, marker, proof, {}, repositoryLockHeld).catch(() => undefined);
    const held = sentinelExcludeHandles.get(marker);
    sentinelExcludeHandles.delete(marker);
    await held?.close().catch(() => undefined);
    throw error;
  }
}

interface CreateWorktreeOptions {
  /** Narrow test seam: portable sentinel mode still pins the directory for safe relative creation. */
  directoryDescriptorMode?: "supported" | "unsupported" | "open-unsupported";
  /** Narrow test seam for a platform with directory descriptors but no verified descriptor aliases. */
  descriptorAliasMode?: "supported" | "unsupported";
  /** Simulate a pathname-only rollback accepting a replacement with a reused numeric identity. */
  simulateReusedAllocationPathIdentity?: boolean;
  /** Runs after alias identity verification and before an exclusive descriptor-relative proof write. */
  beforeDescriptorRelativeWrite?: (kind: DescriptorRelativeWriteKind, directoryPath: string) => void | Promise<void>;
  /** Narrow test seam for portable Git-registration-directory finalization. */
  gitDirectoryDescriptorErrorCode?: "EISDIR" | "ENOTSUP";
  /** Narrow test seam for failures after git has created the worktree. */
  canonicalizePath?: (path: string) => Promise<string>;
  /** Narrow test seam for simulating older Git command support. */
  execGit?: GitExecutor;
  /** Runs after the private direct-child directory is atomically allocated and identity-bound. */
  afterAtomicDirectoryCreation?: (gitCommonRoot: string, worktreePath: string) => void | Promise<void>;
  /** Runs after branch creation and immediately before the final path identity check. */
  afterBranchCreationBeforeGitAdd?: (gitCommonRoot: string, worktreePath: string) => void | Promise<void>;
  /** Narrow test seam for unsuccessful exact-identity post-create cleanup. */
  rollbackFinalizedWorktree?: (worktree: Worktree) => Promise<WorktreeCleanupFailure[]>;
  /** Narrow test seam for partial `git worktree add` transactional recovery. */
  creationCleanupHooks?: WorktreeCleanupTestHooks;
  /** Narrow test seam for registration persistence failures during identity finalization. */
  beforeRegistrationRecordWrite?: (metadata: WorktreeCleanupMetadataV4) => void | Promise<void>;
  /** Runs after registration persistence and immediately before final ownership revalidation. */
  afterRegistrationRecordWrite?: (metadata: WorktreeCleanupMetadataV4) => void | Promise<void>;
}

interface AllocatedCheckoutRollback {
  gitCommonRoot: string;
  worktreePath: string;
  allocatedIdentity?: FileIdentity;
  allocatedHandle?: FileHandle;
  simulateReusedPathIdentity?: boolean;
}

async function closeAllocationDescriptor(handle: FileHandle | undefined): Promise<void> {
  if (!handle) return;
  allocationDescriptorCount -= 1;
  await handle.close().catch(() => undefined);
}

async function rollbackAllocatedCheckoutDirectory(
  allocated: AllocatedCheckoutRollback,
): Promise<WorktreeCleanupFailure[]> {
  const identity = opaqueCleanupIdentity({
    repoRoot: allocated.gitCommonRoot,
    worktreePath: allocated.worktreePath,
    branchRef: "",
    baseSha: "",
  });
  if (!allocated.worktreePath || !allocated.allocatedIdentity) return [];

  try {
    const [pathStats, handleStats] = await Promise.all([
      lstat(allocated.worktreePath, { bigint: true }).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      }),
      allocated.allocatedHandle?.stat({ bigint: true }),
    ]);
    if (!pathStats) return [];
    const pathMatchesRecordedIdentity =
      allocated.simulateReusedPathIdentity || hasFileIdentity(pathStats, allocated.allocatedIdentity);
    const descriptorMatchesPath = handleStats === undefined || hasFileIdentity(pathStats, fileIdentity(handleStats));
    if (
      pathStats.isSymbolicLink() ||
      !pathStats.isDirectory() ||
      !pathMatchesRecordedIdentity ||
      (!handleStats?.isDirectory() && allocated.allocatedHandle !== undefined) ||
      !descriptorMatchesPath
    ) {
      return [
        {
          stage: "worktree_remove",
          message: boundedDiagnostic(
            "allocated checkout pathname no longer matches its retained descriptor; replacement preserved and descriptor-owned state requires bounded recovery",
          ),
          identity,
        },
      ];
    }

    const claimPath = join(allocated.gitCommonRoot, `.pi-dynamic-workflows-allocation-rollback-${randomUUID()}`);
    await rename(allocated.worktreePath, claimPath);
    const [claimedStats, finalHandleStats] = await Promise.all([
      lstat(claimPath, { bigint: true }),
      allocated.allocatedHandle?.stat({ bigint: true }),
    ]);
    const claimedIdentity = fileIdentity(claimedStats);
    if (
      claimedStats.isSymbolicLink() ||
      !claimedStats.isDirectory() ||
      !hasFileIdentity(claimedStats, allocated.allocatedIdentity) ||
      (allocated.allocatedHandle !== undefined &&
        (!finalHandleStats?.isDirectory() || !hasFileIdentity(claimedStats, fileIdentity(finalHandleStats))))
    ) {
      const restoration = await restoreUnexpectedClaim(allocated.worktreePath, claimPath, claimedIdentity);
      return [
        {
          stage: "worktree_remove",
          message: boundedDiagnostic(`allocated checkout rollback captured a replacement; ${restoration}`),
          identity,
        },
      ];
    }
    await rmdir(claimPath);
    return [];
  } catch (error) {
    return [
      {
        stage: "worktree_remove",
        message: boundedDiagnostic(`allocated checkout rollback stopped safely: ${errorMessage(error)}`),
        identity,
      },
    ];
  }
}

/**
 * Create an isolated worktree in an atomically allocated runtime-only direct
 * child of the canonical Git common directory, on branch `pi/wf/<name>`. This
 * keeps checkouts outside the repository status namespace and avoids the
 * historically shared `.pi/worktrees` parent. The exact HEAD SHA is retained
 * as identity metadata. Returns a no-op Worktree on failure.
 */
export async function createWorktree(
  baseCwd: string,
  name: string,
  options: CreateWorktreeOptions = {},
): Promise<Worktree> {
  const id = slug(name);
  const canonicalizePath = options.canonicalizePath ?? realpath;
  const gitExec = options.execGit ?? executeGit;
  let repoRoot: string;
  let gitCommonRoot: string;
  let baseSha: string;
  try {
    const [{ stdout: rootOutput }, { stdout: shaOutput }, commonRoot] = await Promise.all([
      gitExec(["-C", baseCwd, "rev-parse", "--show-toplevel"]),
      gitExec(["-C", baseCwd, "rev-parse", "HEAD"]),
      resolveGitDirectory(baseCwd, "--git-common-dir", gitExec),
    ]);
    repoRoot = await canonicalizePath(rootOutput.trim());
    gitCommonRoot = await realDirectory(commonRoot, false);
    baseSha = shaOutput.trim();
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(baseSha)) {
      throw new Error("HEAD does not have a supported object ID");
    }
  } catch {
    return { isolated: false, cwd: baseCwd, reason: "not a git repository" };
  }

  const branch = `pi/wf/${id}`;
  const branchRef = `refs/heads/${branch}`;
  const nullOid = "0".repeat(baseSha.length);
  let requestedPath = "";
  let allocatedIdentity: FileIdentity | undefined;
  let allocatedHandle: FileHandle | undefined;
  try {
    requestedPath = await mkdtemp(join(gitCommonRoot, `${RUNTIME_WORKTREE_PREFIX}${id}-`));
    const allocatedStats = await lstat(requestedPath, { bigint: true });
    if (!allocatedStats.isDirectory() || allocatedStats.isSymbolicLink()) {
      throw new Error("atomically allocated worktree path is not a real directory");
    }
    allocatedIdentity = fileIdentity(allocatedStats);
    if (options.directoryDescriptorMode === "open-unsupported") {
      throw forcedDirectoryDescriptorError("ENOTSUP");
    }
    allocatedHandle = await open(requestedPath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    allocationDescriptorCount += 1;
    if (allocatedHandle) {
      const allocatedHandleStats = await allocatedHandle.stat({ bigint: true });
      if (!allocatedHandleStats.isDirectory() || !hasFileIdentity(allocatedHandleStats, allocatedIdentity)) {
        throw new Error("atomically allocated worktree descriptor does not match its path identity");
      }
    }
    if (!isExactRuntimeWorktreeChild(gitCommonRoot, requestedPath)) {
      throw new Error("atomically allocated worktree path is not an exact Git-common-dir child");
    }
    await options.afterAtomicDirectoryCreation?.(gitCommonRoot, requestedPath);
    const beforeGitStats = await lstat(requestedPath, { bigint: true });
    if (!beforeGitStats.isDirectory() || !hasFileIdentity(beforeGitStats, allocatedIdentity)) {
      throw new Error("atomically allocated worktree identity changed before Git creation");
    }
  } catch {
    const boundedFailures = (
      await rollbackAllocatedCheckoutDirectory({
        gitCommonRoot,
        worktreePath: requestedPath,
        allocatedIdentity,
        allocatedHandle,
        simulateReusedPathIdentity: options.simulateReusedAllocationPathIdentity,
      })
    ).map(sanitizeWorktreeCleanupFailure);
    await closeAllocationDescriptor(allocatedHandle);
    allocatedHandle = undefined;
    return {
      isolated: false,
      cwd: baseCwd,
      reason: creationFailureReason("unsafe_allocation", boundedFailures),
      ...(boundedFailures.length > 0 ? { recoveryFailures: boundedFailures } : {}),
    };
  }

  try {
    await gitExec(["-C", repoRoot, "update-ref", "--no-deref", branchRef, baseSha, nullOid]);
  } catch {
    const boundedFailures = (
      await rollbackAllocatedCheckoutDirectory({
        gitCommonRoot,
        worktreePath: requestedPath,
        allocatedIdentity,
        allocatedHandle,
        simulateReusedPathIdentity: options.simulateReusedAllocationPathIdentity,
      })
    ).map(sanitizeWorktreeCleanupFailure);
    await closeAllocationDescriptor(allocatedHandle);
    allocatedHandle = undefined;
    return {
      isolated: false,
      cwd: baseCwd,
      reason: creationFailureReason("branch_create", boundedFailures),
      ...(boundedFailures.length > 0 ? { recoveryFailures: boundedFailures } : {}),
    };
  }

  try {
    await options.afterBranchCreationBeforeGitAdd?.(gitCommonRoot, requestedPath);
    const [preAddStats, preAddCanonicalPath, preAddHandleStats] = await Promise.all([
      lstat(requestedPath, { bigint: true }),
      realpath(requestedPath),
      allocatedHandle?.stat({ bigint: true }),
    ]);
    if (
      preAddCanonicalPath !== requestedPath ||
      preAddStats.isSymbolicLink() ||
      !preAddStats.isDirectory() ||
      !allocatedIdentity ||
      (allocatedHandle !== undefined &&
        (!preAddHandleStats?.isDirectory() || !hasFileIdentity(preAddHandleStats, allocatedIdentity))) ||
      !hasFileIdentity(preAddStats, allocatedIdentity) ||
      !isExactRuntimeWorktreeChild(gitCommonRoot, preAddCanonicalPath)
    ) {
      throw new Error("atomically allocated worktree identity changed before Git worktree add");
    }
  } catch {
    const boundedFailures = (
      await recoverFailedWorktreeCreation(
        {
          repoRoot,
          gitCommonRoot,
          worktreePath: requestedPath,
          branch,
          branchRef,
          baseSha,
          nullOid,
          allocatedIdentity,
          allocatedHandle,
        },
        options.creationCleanupHooks ?? {},
      )
    ).map(sanitizeWorktreeCleanupFailure);
    await closeAllocationDescriptor(allocatedHandle);
    allocatedHandle = undefined;
    return {
      isolated: false,
      cwd: baseCwd,
      reason: creationFailureReason("pre_add_verification", boundedFailures),
      ...(boundedFailures.length > 0 ? { recoveryFailures: boundedFailures } : {}),
    };
  }

  try {
    await withRepositoryGitMetadataCleanup(gitCommonRoot, () =>
      gitExec(["-C", repoRoot, "worktree", "add", requestedPath, branch]),
    );
  } catch {
    const boundedFailures = (
      await recoverFailedWorktreeCreation(
        {
          repoRoot,
          gitCommonRoot,
          worktreePath: requestedPath,
          branch,
          branchRef,
          baseSha,
          nullOid,
          allocatedIdentity,
          allocatedHandle,
        },
        options.creationCleanupHooks ?? {},
      )
    ).map(sanitizeWorktreeCleanupFailure);
    await closeAllocationDescriptor(allocatedHandle);
    allocatedHandle = undefined;
    return {
      isolated: false,
      cwd: baseCwd,
      reason: creationFailureReason("git_add", boundedFailures),
      ...(boundedFailures.length > 0 ? { recoveryFailures: boundedFailures } : {}),
    };
  }

  let finalizedWorktree: Worktree | undefined;
  let finalizingWorktree: Worktree | undefined;
  let finalizingRecoveryIdentity: FailedWorktreeCreationIdentity | undefined;
  let finalizingMarker: string | undefined;
  let finalizingGitDirHandle: FileHandle | undefined;
  let finalizingGitDirSentinel: Extract<WorktreeGitDirectoryProof, { kind: "sentinel" }> | undefined;
  let finalizingGitDirIdentity: FileIdentity | undefined;
  let finalizingGitDir = "";
  let registrationPersisted = false;
  let creationRecoveryWorktree: Worktree | undefined;
  try {
    const cwd = await realpath(requestedPath);
    const createdStats = await lstat(cwd, { bigint: true });
    if (
      cwd !== requestedPath ||
      !allocatedIdentity ||
      !createdStats.isDirectory() ||
      !hasFileIdentity(createdStats, allocatedIdentity) ||
      !isExactRuntimeWorktreeChild(gitCommonRoot, cwd)
    ) {
      throw new Error("created worktree no longer matches its atomically allocated Git-common-dir identity");
    }
    const [createdCommonRoot, gitDir, expectedCommonRoot] = await Promise.all([
      resolveGitDirectory(cwd, "--git-common-dir", gitExec),
      resolveGitDirectory(cwd, "--git-dir", gitExec),
      resolveGitDirectory(repoRoot, "--git-common-dir", gitExec),
    ]);
    if (createdCommonRoot !== expectedCommonRoot || createdCommonRoot !== gitCommonRoot) {
      throw new Error("created worktree has an unexpected Git common root");
    }

    const registrationMarker = randomUUID();
    finalizingMarker = registrationMarker;
    finalizingGitDir = gitDir;
    // Establish exact path, branch, checkout-inode, and descriptor authority
    // before either portable proof can create a sentinel side effect.
    finalizingRecoveryIdentity = {
      repoRoot,
      gitCommonRoot: createdCommonRoot,
      worktreePath: cwd,
      branch,
      branchRef,
      baseSha,
      nullOid,
      allocatedIdentity,
      allocatedHandle,
    };
    const descriptorWriteOptions: DescriptorRelativeWriteOptions = {
      aliasMode: options.descriptorAliasMode,
      beforeWrite: options.beforeDescriptorRelativeWrite,
    };
    const gitDirectoryOwnership = await createGitDirectoryOwnershipProof(
      gitDir,
      options.gitDirectoryDescriptorErrorCode,
      descriptorWriteOptions,
    );
    finalizingGitDirHandle = gitDirectoryOwnership.handle;
    finalizingGitDirIdentity = gitDirectoryOwnership.identity;
    if (gitDirectoryOwnership.proof.kind === "sentinel") {
      finalizingGitDirSentinel = gitDirectoryOwnership.proof;
    }
    if (!allocatedHandle) throw new Error("safe checkout-directory descriptor is unavailable");
    const checkoutProof =
      options.directoryDescriptorMode === "unsupported"
        ? await createCheckoutSentinel(
            cwd,
            createdCommonRoot,
            registrationMarker,
            allocatedIdentity,
            allocatedHandle,
            false,
            descriptorWriteOptions,
          )
        : ({ kind: "descriptor" } as const);
    const cleanupMetadata: WorktreeCleanupMetadataV4 = Object.freeze({
      version: 4,
      registrationMarker,
      repoRoot,
      worktreePath: cwd,
      checkoutIdentity: { ...allocatedIdentity },
      checkoutProof,
      gitDirIdentity: gitDirectoryOwnership.identity,
      gitDirProof: gitDirectoryOwnership.proof,
      branch,
      branchRef,
      baseSha,
      gitCommonRoot: createdCommonRoot,
      gitDir,
    });
    finalizingWorktree = { isolated: true, cwd, branch, branchRef, baseSha, repoRoot, cleanupMetadata };
    // Transfer every proof into process-local root authority before persistence.
    // A marker write failure can therefore roll back without trusting a pathname.
    if (allocatedHandle && checkoutProof.kind === "descriptor") {
      checkoutDirectoryHandles.set(registrationMarker, allocatedHandle);
      allocationDescriptorCount -= 1;
      allocatedHandle = undefined;
    }
    if (finalizingGitDirHandle && gitDirectoryOwnership.proof.kind === "descriptor") {
      gitDirectoryHandles.set(registrationMarker, finalizingGitDirHandle);
      finalizingGitDirHandle = undefined;
    }
    creationRecoveryAuthorities.set(finalizingWorktree, "in-memory");
    await options.beforeRegistrationRecordWrite?.(cleanupMetadata);
    const registrationHandle = gitDirectoryHandles.get(registrationMarker) ?? finalizingGitDirHandle;
    if (!registrationHandle) throw new Error("safe Git registration-directory descriptor is unavailable");
    await writeRegistrationRecord(
      gitDir,
      cleanupMetadata,
      { handle: registrationHandle, identity: gitDirectoryOwnership.identity },
      descriptorWriteOptions,
    );
    registrationPersisted = true;
    if (gitDirectoryOwnership.proof.kind === "sentinel") {
      await finalizingGitDirHandle?.close().catch(() => undefined);
      finalizingGitDirHandle = undefined;
    }
    creationRecoveryAuthorities.set(finalizingWorktree, "persisted");
    finalizingGitDirSentinel = undefined;
    finalizedWorktree = finalizingWorktree;

    // This deterministic final hook is deliberately after marker persistence.
    // No agent can observe the checkout until every current proof is revalidated.
    await options.afterRegistrationRecordWrite?.(cleanupMetadata);
    if ((await canonicalizePath(requestedPath)) !== cwd) {
      throw new Error("created worktree path changed during final ownership revalidation");
    }
    const finalVerification = await verifyCleanupIdentity(finalizedWorktree);
    if (
      typeof finalVerification === "string" ||
      finalVerification.checkoutPath !== cwd ||
      finalVerification.branchOid !== baseSha
    ) {
      throw new Error(
        typeof finalVerification === "string"
          ? `created worktree final ownership revalidation failed: ${finalVerification}`
          : "created worktree identity changed during final ownership revalidation",
      );
    }
    creationRecoveryAuthorities.delete(finalizedWorktree);
    await closeAllocationDescriptor(allocatedHandle);
    allocatedHandle = undefined;
    return finalizedWorktree;
  } catch {
    const recoveryIdentity = opaqueCleanupIdentity({ repoRoot, worktreePath: requestedPath, branchRef, baseSha });
    const recoveryFailures: WorktreeCleanupFailure[] = [];
    const rollbackFinalized = async (value: Worktree): Promise<boolean> => {
      try {
        const customRollback = options.rollbackFinalizedWorktree;
        const failures = customRollback
          ? await customRollback(value)
          : await removeWorktreeWithDiagnostics(value, {
              ...(options.creationCleanupHooks ?? {}),
              creationRollbackExpectedOid: baseSha,
            });
        for (const failure of failures) {
          recoveryFailures.push({ ...failure, message: boundedDiagnostic(failure.message) });
        }
        if (
          failures.length === 0 ||
          (!customRollback &&
            failures.length === 1 &&
            failures[0]?.message.startsWith(CREATION_ADVANCED_BRANCH_PRESERVED))
        ) {
          return true;
        }
      } catch (rollbackError) {
        recoveryFailures.push({
          stage: "cleanup_dispatch",
          message: boundedDiagnostic(
            `exact-identity worktree creation rollback failed: ${errorMessage(rollbackError)}`,
          ),
          identity: recoveryIdentity,
        });
      }
      value.creationRollbackExpectedOid = baseSha;
      creationRecoveryWorktree = value;
      return false;
    };
    if (finalizedWorktree) {
      await rollbackFinalized(finalizedWorktree);
    } else if (finalizingWorktree) {
      if (!registrationPersisted) {
        recoveryFailures.push({
          stage: "cleanup_dispatch",
          message: "registration persistence failed; exact in-memory creation identity authorized immediate rollback",
          identity: recoveryIdentity,
        });
      }
      await rollbackFinalized(finalizingWorktree);
      if (!creationRecoveryWorktree) {
        // A successful rollback is a clean isolation fallback, not a recovery failure.
        recoveryFailures.length = 0;
      }
    } else if (finalizingRecoveryIdentity) {
      for (const failure of await recoverFailedWorktreeCreation(
        finalizingRecoveryIdentity,
        options.creationCleanupHooks ?? {},
      )) {
        recoveryFailures.push({ ...failure, message: boundedDiagnostic(failure.message) });
      }
    } else {
      recoveryFailures.push(
        {
          stage: "worktree_remove",
          message: "worktree creation rollback lacks a complete exact recovery identity",
          identity: recoveryIdentity,
        },
        {
          stage: "branch_delete",
          message: "temporary branch remains reachable with the preserved exact worktree registration",
          identity: recoveryIdentity,
        },
      );
    }
    if (creationRecoveryWorktree && allocatedHandle && finalizingMarker) {
      checkoutDirectoryHandles.set(finalizingMarker, allocatedHandle);
      allocationDescriptorCount -= 1;
      allocatedHandle = undefined;
    }
    if (!creationRecoveryWorktree) {
      await closeAllocationDescriptor(allocatedHandle);
      allocatedHandle = undefined;
      await finalizingGitDirHandle?.close().catch(() => undefined);
      finalizingGitDirHandle = undefined;
      if (finalizingGitDirSentinel && finalizingGitDir) {
        const currentGitDir = await lstat(finalizingGitDir, { bigint: true }).catch(() => undefined);
        if (
          currentGitDir?.isDirectory() &&
          finalizingGitDirIdentity &&
          hasFileIdentity(currentGitDir, finalizingGitDirIdentity)
        ) {
          await rm(join(finalizingGitDir, finalizingGitDirSentinel.fileName), { force: true }).catch(() => undefined);
        }
      }
      const finalizedMarker = finalizedWorktree?.cleanupMetadata?.registrationMarker ?? finalizingMarker;
      if (finalizedMarker) await closeRuntimeIdentityHandles(finalizedMarker);
    }
    const publicRecoveryFailures = recoveryFailures.map(sanitizeWorktreeCleanupFailure);
    return {
      isolated: false,
      cwd: baseCwd,
      reason: creationFailureReason("identity_finalization", publicRecoveryFailures),
      ...(publicRecoveryFailures.length > 0 ? { recoveryFailures: publicRecoveryFailures } : {}),
      ...(creationRecoveryWorktree ? { creationRecoveryWorktree } : {}),
    };
  }
}

interface FailedWorktreeCreationIdentity {
  repoRoot: string;
  gitCommonRoot: string;
  worktreePath: string;
  branch: string;
  branchRef: string;
  baseSha: string;
  nullOid: string;
  allocatedIdentity: FileIdentity;
  allocatedHandle?: FileHandle;
}

async function findExactPartialRegistrationGitDir(
  gitCommonRoot: string,
  worktreePath: string,
): Promise<string | undefined> {
  let worktreesRoot: string;
  try {
    worktreesRoot = await secureChildDirectory(gitCommonRoot, "worktrees", false);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }

  const matches: string[] = [];
  for (const entry of await readdir(worktreesRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const candidate = join(worktreesRoot, entry.name);
    let canonicalCandidate: string;
    try {
      canonicalCandidate = await realDirectory(candidate, false);
      const gitdirLink = (await readRegistrationFile(join(canonicalCandidate, "gitdir"))).trim();
      const checkoutLink = isAbsolute(gitdirLink) ? resolve(gitdirLink) : resolve(canonicalCandidate, gitdirLink);
      if (checkoutLink === join(worktreePath, ".git")) matches.push(canonicalCandidate);
    } catch {
      // Unrelated or concurrently changing Git metadata is never cleanup authority.
    }
  }
  if (matches.length > 1) throw new Error("multiple per-worktree Git registrations resolve to the failed checkout");
  return matches[0];
}

async function failedCreationSentinelProof(
  failed: FailedWorktreeCreationIdentity,
  marker: string,
): Promise<Extract<WorktreeCheckoutProof, { kind: "sentinel" }> | undefined> {
  try {
    if (!failed.allocatedHandle) return undefined;
    await verifySentinelCheckoutPath(failed.worktreePath, failed.allocatedIdentity, failed.allocatedHandle);
    return (await createCheckoutSentinel(
      failed.worktreePath,
      failed.gitCommonRoot,
      marker,
      failed.allocatedIdentity,
      failed.allocatedHandle,
    )) as Extract<WorktreeCheckoutProof, { kind: "sentinel" }>;
  } catch {
    return undefined;
  }
}

function failedCreationWorktree(
  failed: FailedWorktreeCreationIdentity,
  gitDir: string,
  marker: string,
  checkoutProof: WorktreeCheckoutProof,
  gitDirIdentity: FileIdentity,
  gitDirProof?: WorktreeGitDirectoryProof,
): Worktree {
  const cleanupMetadata: WorktreeCleanupMetadataV4 = Object.freeze({
    version: 4,
    registrationMarker: marker,
    repoRoot: failed.repoRoot,
    worktreePath: failed.worktreePath,
    checkoutIdentity: { ...failed.allocatedIdentity },
    checkoutProof,
    gitDirIdentity: { ...gitDirIdentity },
    ...(gitDirProof ? { gitDirProof } : {}),
    branch: failed.branch,
    branchRef: failed.branchRef,
    baseSha: failed.baseSha,
    gitCommonRoot: failed.gitCommonRoot,
    gitDir,
  });
  return {
    isolated: true,
    cwd: failed.worktreePath,
    branch: failed.branch,
    branchRef: failed.branchRef,
    baseSha: failed.baseSha,
    repoRoot: failed.repoRoot,
    cleanupMetadata,
  };
}

async function rollbackUnregisteredWorktreeCreation(
  failed: FailedWorktreeCreationIdentity,
  hooks: WorktreeCleanupTestHooks,
): Promise<WorktreeCleanupFailure[]> {
  const identity = opaqueCleanupIdentity({
    repoRoot: failed.repoRoot,
    worktreePath: failed.worktreePath,
    branchRef: failed.branchRef,
    baseSha: failed.baseSha,
  });
  const marker = randomUUID();
  const recoveryGitDir = join(failed.gitCommonRoot, `pi-workflow-unregistered-${marker}`);
  const portableProof = await failedCreationSentinelProof(failed, marker);
  const worktree = failedCreationWorktree(
    failed,
    recoveryGitDir,
    marker,
    portableProof ?? ({ kind: "descriptor" } as const),
    { dev: "0", ino: "0" },
  );
  const expected = runtimeIdentity(worktree);
  if (typeof expected === "string") return [identityFailure(identity, expected)];

  const failures = await withRepositoryGitMetadataCleanup<WorktreeCleanupFailure[]>(failed.gitCommonRoot, async () => {
    let claimedCheckout: ClaimedDirectory | undefined;
    let claimedBranch: ClaimedBranch | undefined;
    const stop = async (stage: WorktreeCleanupStage, message: string): Promise<WorktreeCleanupFailure[]> => {
      if (claimedCheckout?.restorable === false) {
        await claimedCheckout.handle?.close().catch(() => undefined);
        return [
          {
            stage,
            message: boundedDiagnostic(
              `${message}; exact pending checkout claim and internal backup ref were preserved for deterministic recovery`,
            ),
            identity,
          },
        ];
      }
      const restoration: string[] = [];
      if (claimedBranch) {
        restoration.push(
          await restoreClaimedBranch(
            {
              expected,
              checkoutIdentity: failed.allocatedIdentity,
              gitDirIdentity: { dev: "0", ino: "0" },
              branchOid: failed.baseSha,
              nullOid: failed.nullOid,
            },
            claimedBranch,
          ),
        );
      }
      if (claimedCheckout) restoration.push(await restoreClaimedDirectory(claimedCheckout, "checkout"));
      return [
        {
          stage,
          message: boundedDiagnostic(`${message}${restoration.length > 0 ? `; ${restoration.join("; ")}` : ""}`),
          identity,
        },
      ];
    };

    const registrations = await readRegisteredWorktrees(failed.repoRoot);
    if (
      registrations.some(
        (registration) => registration.path === failed.worktreePath || registration.branchRef === failed.branchRef,
      )
    ) {
      return [
        identityFailure(identity, "failed checkout unexpectedly remains registered; unregistered rollback stopped"),
      ];
    }

    const checkoutStats = await lstat(failed.worktreePath, { bigint: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (
      checkoutStats?.isDirectory() &&
      !checkoutStats.isSymbolicLink() &&
      hasFileIdentity(checkoutStats, failed.allocatedIdentity)
    ) {
      const claimParent = await secureCleanupClaimParent(expected);
      const checkoutClaim = await claimDirectory(
        worktree,
        "checkout",
        failed.worktreePath,
        claimParent,
        "failed-creation-checkout",
        failed.allocatedIdentity,
        hooks,
      );
      if (typeof checkoutClaim === "string") return [identityFailure(identity, checkoutClaim)];
      claimedCheckout = checkoutClaim;
      try {
        await hooks.afterCheckoutClaim?.(worktree);
      } catch (error) {
        return stop("cleanup_dispatch", `failed-creation checkout claim hook failed: ${errorMessage(error)}`);
      }
    }

    const verified: VerifiedCleanupIdentity = {
      expected,
      checkoutIdentity: claimedCheckout ? failed.allocatedIdentity : undefined,
      gitDirIdentity: { dev: "0", ino: "0" },
      branchOid: failed.baseSha,
      nullOid: failed.nullOid,
    };
    const branchClaim = await claimBranch(worktree, verified, hooks);
    if (typeof branchClaim === "string") return stop("branch_delete", branchClaim);
    claimedBranch = branchClaim;
    try {
      await hooks.afterBranchClaim?.(worktree);
      await hooks.beforePostClaimRegistrationCheck?.(worktree);
      const postClaimRegistrations = await readRegisteredWorktrees(failed.repoRoot);
      if (
        postClaimRegistrations.some(
          (registration) => registration.path === failed.worktreePath || registration.branchRef === failed.branchRef,
        )
      ) {
        return stop("identity_verification", "a registration appeared during failed-creation rollback");
      }
    } catch (error) {
      return stop("cleanup_dispatch", `failed-creation rollback verification failed: ${errorMessage(error)}`);
    }

    if (claimedCheckout) {
      const checkoutFailure = await cleanupClaimedContents(worktree, "checkout", claimedCheckout, hooks);
      if (checkoutFailure) return stop("worktree_remove", checkoutFailure);
      claimedCheckout = undefined;
    }
    const branchFailure = await deleteClaimedBranch(worktree, expected, branchClaim, hooks);
    if (branchFailure) {
      return [{ stage: "branch_delete", message: boundedDiagnostic(branchFailure), identity }];
    }
    return [];
  });
  if (failures.length === 0 && portableProof) {
    try {
      await removeSentinelExclude(failed.gitCommonRoot, marker, portableProof, hooks);
    } catch (error) {
      return [
        {
          stage: "worktree_remove",
          message: boundedDiagnostic(`portable sentinel restoration failed: ${errorMessage(error)}`),
          identity,
        },
      ];
    }
  }
  return failures;
}

async function verifyFailedCreationBranchAtBase(failed: FailedWorktreeCreationIdentity): Promise<void> {
  const { stdout } = await exec("git", [
    "-C",
    failed.repoRoot,
    "for-each-ref",
    "--format=%(objectname)%00%(symref)",
    failed.branchRef,
  ]);
  const record = stdout.trimEnd();
  if (!record) throw new Error("temporary branch disappeared before failed-creation rollback");
  const [oid, symref = ""] = record.split("\0");
  if (symref.length > 0) throw new Error("temporary branch became symbolic before failed-creation rollback");
  if (oid !== failed.baseSha) throw new Error("temporary branch advanced from its expected start OID");
}

async function recoverFailedWorktreeCreation(
  failed: FailedWorktreeCreationIdentity,
  hooks: WorktreeCleanupTestHooks,
): Promise<WorktreeCleanupFailure[]> {
  const identity = opaqueCleanupIdentity({
    repoRoot: failed.repoRoot,
    worktreePath: failed.worktreePath,
    branchRef: failed.branchRef,
    baseSha: failed.baseSha,
  });
  try {
    if (!isExactRuntimeWorktreeChild(failed.gitCommonRoot, failed.worktreePath)) {
      return [identityFailure(identity, "failed checkout is not an exact runtime direct child of the Git common root")];
    }
    const commonRoot = await realDirectory(failed.gitCommonRoot, false);
    if (commonRoot !== failed.gitCommonRoot) {
      return [identityFailure(identity, "failed checkout Git common root is no longer canonical")];
    }
    const registrations = await registeredWorktrees(failed.repoRoot, failed.gitCommonRoot);
    const exactRegistrations = registrations.filter((registration) => registration.path === failed.worktreePath);
    if (exactRegistrations.length > 1) {
      return [identityFailure(identity, "multiple registrations name the failed checkout path")];
    }
    if (
      registrations.some(
        (registration) => registration.path !== failed.worktreePath && registration.branchRef === failed.branchRef,
      )
    ) {
      return [identityFailure(identity, "temporary branch is checked out by another registered worktree")];
    }

    const registration = exactRegistrations[0];
    if (!registration) return rollbackUnregisteredWorktreeCreation(failed, hooks);
    if (registration.branchRef !== failed.branchRef) {
      return [identityFailure(identity, "failed checkout registration has an unexpected branch")];
    }

    const checkoutStats = await lstat(failed.worktreePath, { bigint: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (
      checkoutStats &&
      (checkoutStats.isSymbolicLink() ||
        !checkoutStats.isDirectory() ||
        !hasFileIdentity(checkoutStats, failed.allocatedIdentity))
    ) {
      return [identityFailure(identity, "registered failed checkout no longer names its atomically allocated inode")];
    }

    const gitDir = await findExactPartialRegistrationGitDir(failed.gitCommonRoot, failed.worktreePath);
    if (!gitDir) {
      return [identityFailure(identity, "exact failed checkout registration has no matching per-worktree gitdir")];
    }
    await verifyFailedCreationBranchAtBase(failed);
    const marker = randomUUID();
    const portableProof = await failedCreationSentinelProof(failed, marker);
    if (!portableProof) {
      return [
        identityFailure(
          identity,
          "registered failed checkout cannot initialize portable ownership without its allocated descriptor",
        ),
      ];
    }
    const gitDirectoryOwnership = await createGitDirectoryOwnershipProof(gitDir);
    if (gitDirectoryOwnership.handle) gitDirectoryHandles.set(marker, gitDirectoryOwnership.handle);
    const worktree = failedCreationWorktree(
      failed,
      gitDir,
      marker,
      portableProof,
      gitDirectoryOwnership.identity,
      gitDirectoryOwnership.proof,
    );
    try {
      await writeRegistrationRecord(gitDir, worktree.cleanupMetadata as WorktreeCleanupMetadataV4);
    } catch (error) {
      await closeRuntimeIdentityHandles(marker);
      throw error;
    }
    const callerIdentityHook = hooks.afterIdentityVerification;
    return removeWorktreeWithDiagnostics(worktree, {
      ...hooks,
      async afterIdentityVerification(value) {
        await verifyFailedCreationBranchAtBase(failed);
        await callerIdentityHook?.(value);
      },
    });
  } catch (error) {
    return [
      {
        stage: "cleanup_dispatch",
        message: boundedDiagnostic(`failed worktree creation recovery could not complete: ${errorMessage(error)}`),
        identity,
      },
    ];
  }
}

function cleanupIdentity(worktree: Worktree): WorktreeIdentity {
  return opaqueCleanupIdentity({
    repoRoot: worktree.repoRoot ?? "",
    worktreePath: worktree.cwd,
    branchRef: worktree.branchRef ?? (worktree.branch ? `refs/heads/${worktree.branch}` : ""),
    baseSha: worktree.baseSha ?? "",
  });
}

interface RegisteredWorktree {
  path: string;
  branchRef?: string;
}

function parseRegisteredWorktrees(output: string): RegisteredWorktree[] {
  return output
    .split("\0\0")
    .map((record) => record.split("\0"))
    .map((fields) => ({
      path: fields.find((field) => field.startsWith("worktree "))?.slice("worktree ".length) ?? "",
      branchRef: fields.find((field) => field.startsWith("branch "))?.slice("branch ".length),
    }))
    .filter((registration) => registration.path.length > 0);
}

interface FileIdentity extends WorktreeFilesystemIdentity {}

interface VerifiedCleanupIdentity {
  expected: RuntimeWorktreeIdentity;
  checkoutIdentity?: FileIdentity;
  checkoutPath?: string;
  gitDirIdentity: FileIdentity;
  branchOid: string;
  nullOid: string;
}

type DirectoryClaimKind = "checkout" | "registration";

interface WorktreeCleanupTestHooks {
  afterIdentityVerification?: (worktree: Worktree) => void | Promise<void>;
  beforeDirectoryClaim?: (worktree: Worktree, kind: DirectoryClaimKind, sourcePath: string) => void | Promise<void>;
  afterDirectoryRename?: (worktree: Worktree, kind: DirectoryClaimKind, sourcePath: string) => void | Promise<void>;
  afterCheckoutClaim?: (worktree: Worktree) => void | Promise<void>;
  afterWorktreeClaim?: (worktree: Worktree) => void | Promise<void>;
  afterBranchRefRead?: (worktree: Worktree) => void | Promise<void>;
  afterBranchClaim?: (worktree: Worktree) => void | Promise<void>;
  afterRegistrationClaim?: (worktree: Worktree) => void | Promise<void>;
  beforeClaimedContentsCleanup?: (worktree: Worktree, kind: DirectoryClaimKind) => void | Promise<void>;
  afterClaimedEntryRemoval?: (
    worktree: Worktree,
    kind: DirectoryClaimKind,
    removedEntries: number,
  ) => void | Promise<void>;
  beforePostClaimRegistrationCheck?: (worktree: Worktree) => void | Promise<void>;
  /** Legacy test seam retained for compatibility; legacy directory locks now fail closed. */
  beforeEmptyRepositoryOperationLockRemoval?: (lockPath: string) => void | Promise<void>;
  /** Runs before final inode/token verification and unlink of a fixed hard-link lock claim. */
  beforeRepositoryOperationLockUnlink?: (lockPath: string, token: string) => void | Promise<void>;
  /** Test-only deadline override; production permits legitimate long cleanup waits. */
  repositoryOperationLockAcquisitionDeadlineMs?: number;
  /** Test-only retry interval override for deterministic bounded-wait assertions. */
  repositoryOperationLockRetryMs?: number;
  beforeClaimedBranchDelete?: (worktree: Worktree) => void | Promise<void>;
  /** Internal creation-only authority: delete the temporary branch only at this exact OID. */
  creationRollbackExpectedOid?: string;
  /** Runs after the first descriptor read and before a fresh read plus in-place sentinel-rule neutralization. */
  beforeSentinelExcludeNeutralize?: () => void | Promise<void>;
  /** Override for proving that Linux descriptor paths are an optional optimization. */
  procDescriptorRoot?: string;
  /** Simulate an inode-only verifier accepting a replacement with a reused numeric identity. */
  simulateReusedCheckoutIdentity?: boolean;
  /** Simulate pathname-only acceptance of a reused Git registration identity. */
  simulateReusedGitDirIdentity?: boolean;
  /** Simulate pathname-only acceptance of a reused Git exclude identity. */
  simulateReusedExcludeIdentity?: boolean;
  /** Force portable Git-registration proof creation while upgrading a legacy identity. */
  gitDirectoryDescriptorErrorCode?: "EISDIR" | "ENOTSUP";
}

function fileIdentity(value: { dev: number | bigint; ino: number | bigint }): FileIdentity {
  return { dev: value.dev.toString(10), ino: value.ino.toString(10) };
}

async function openBoundDirectory(path: string): Promise<{ handle: FileHandle; identity: FileIdentity }> {
  const pathStats = await lstat(path, { bigint: true });
  if (pathStats.isSymbolicLink() || !pathStats.isDirectory())
    throw new Error("directory proof path is not a real directory");
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const handleStats = await handle.stat({ bigint: true });
    const identity = fileIdentity(pathStats);
    if (!handleStats.isDirectory() || !hasFileIdentity(handleStats, identity)) {
      throw new Error("directory proof changed while its descriptor was opened");
    }
    return { handle, identity };
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

type DescriptorRelativeWriteKind = "checkout" | "registration" | "gitDir";

interface DescriptorRelativeWriteOptions {
  aliasMode?: "supported" | "unsupported";
  beforeWrite?: (kind: DescriptorRelativeWriteKind, directoryPath: string) => void | Promise<void>;
}

async function verifiedDescriptorAlias(
  directoryHandle: FileHandle,
  expectedIdentity: FileIdentity,
  aliasMode?: "supported" | "unsupported",
): Promise<string> {
  if (aliasMode === "unsupported") throw new Error("safe descriptor-relative directory aliases are unavailable");
  for (const root of ["/proc/self/fd", "/dev/fd"]) {
    const candidate = join(root, String(directoryHandle.fd));
    try {
      const aliasStats = await stat(candidate, { bigint: true });
      if (aliasStats.isDirectory() && hasFileIdentity(aliasStats, expectedIdentity)) return candidate;
    } catch {
      // Try the next platform alias.
    }
  }
  throw new Error("safe descriptor-relative directory aliases are unavailable");
}

async function writeExclusiveDescriptorRelative(
  directoryPath: string,
  directoryHandle: FileHandle,
  expectedIdentity: FileIdentity,
  fileName: string,
  contents: string,
  kind: DescriptorRelativeWriteKind,
  options: DescriptorRelativeWriteOptions = {},
): Promise<FileIdentity> {
  if (basename(fileName) !== fileName || fileName === "." || fileName === "..") {
    throw new Error("descriptor-relative proof file name is invalid");
  }
  const handleStats = await directoryHandle.stat({ bigint: true });
  if (!handleStats.isDirectory() || !hasFileIdentity(handleStats, expectedIdentity)) {
    throw new Error("descriptor-relative proof directory identity changed");
  }
  const aliasPath = await verifiedDescriptorAlias(directoryHandle, expectedIdentity, options.aliasMode);
  await options.beforeWrite?.(kind, directoryPath);
  const aliasStats = await stat(aliasPath, { bigint: true });
  const freshHandleStats = await directoryHandle.stat({ bigint: true });
  if (
    !aliasStats.isDirectory() ||
    !freshHandleStats.isDirectory() ||
    !hasFileIdentity(aliasStats, expectedIdentity) ||
    !hasFileIdentity(freshHandleStats, expectedIdentity)
  ) {
    throw new Error("descriptor-relative directory alias identity changed before proof write");
  }

  const relativePath = join(aliasPath, fileName);
  const fileHandle = await open(
    relativePath,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    const fileStats = await fileHandle.stat({ bigint: true });
    if (!fileStats.isFile()) throw new Error("descriptor-relative proof is not a regular file");
    await fileHandle.writeFile(contents, { encoding: "utf8" });
    return fileIdentity(fileStats);
  } catch (error) {
    await fileHandle.close().catch(() => undefined);
    await rm(relativePath, { force: true }).catch(() => undefined);
    throw error;
  } finally {
    await fileHandle.close().catch(() => undefined);
  }
}

function forcedDirectoryDescriptorError(code: "EISDIR" | "ENOTSUP"): NodeJS.ErrnoException {
  const error = new Error(`forced unsupported directory descriptor: ${code}`) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

function isCurrentGitDirectorySentinelFileName(fileName: string): boolean {
  return new RegExp(`^${GIT_DIRECTORY_SENTINEL_PREFIX.replaceAll(".", "\\.")}[0-9a-f]{64}$`).test(fileName);
}

async function createGitDirectorySentinel(
  gitDir: string,
  directoryHandle: FileHandle,
  expectedIdentity: FileIdentity,
  writeOptions: DescriptorRelativeWriteOptions = {},
): Promise<Extract<WorktreeGitDirectoryProof, { kind: "sentinel" }>> {
  const token = randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", "");
  const fileName = `${GIT_DIRECTORY_SENTINEL_PREFIX}${randomUUID().replaceAll("-", "")}${randomUUID().replaceAll("-", "")}`;
  const identity = await writeExclusiveDescriptorRelative(
    gitDir,
    directoryHandle,
    expectedIdentity,
    fileName,
    `${token}\n`,
    "gitDir",
    writeOptions,
  );
  return { kind: "sentinel", fileName, token, identity };
}

async function createGitDirectoryOwnershipProof(
  gitDir: string,
  forcedErrorCode?: "EISDIR" | "ENOTSUP",
  writeOptions: DescriptorRelativeWriteOptions = {},
): Promise<{ identity: FileIdentity; proof: WorktreeGitDirectoryProof; handle: FileHandle }> {
  const descriptor = await openBoundDirectory(gitDir);
  try {
    if (!forcedErrorCode) {
      return { identity: descriptor.identity, proof: { kind: "descriptor" }, handle: descriptor.handle };
    }
    const proof = await createGitDirectorySentinel(gitDir, descriptor.handle, descriptor.identity, writeOptions);
    return { identity: descriptor.identity, proof, handle: descriptor.handle };
  } catch (error) {
    await descriptor.handle.close().catch(() => undefined);
    throw error;
  }
}

async function closeRuntimeIdentityHandles(marker: string): Promise<void> {
  const handles = [
    checkoutDirectoryHandles.get(marker),
    gitDirectoryHandles.get(marker),
    sentinelExcludeHandles.get(marker),
  ];
  checkoutDirectoryHandles.delete(marker);
  gitDirectoryHandles.delete(marker);
  sentinelExcludeHandles.delete(marker);
  await Promise.all(handles.map((handle) => handle?.close().catch(() => undefined)));
}

function hasFileIdentity(
  actual: { dev: number | bigint | string; ino: number | bigint | string },
  expected: FileIdentity,
): boolean {
  return actual.dev.toString(10) === expected.dev && actual.ino.toString(10) === expected.ino;
}

function identityFailure(identity: WorktreeIdentity, message: string): WorktreeCleanupFailure {
  return sanitizeWorktreeCleanupFailure({ stage: "identity_verification", message, identity });
}

async function readRegisteredWorktrees(repoRoot: string): Promise<RegisteredWorktree[]> {
  const { stdout } = await exec("git", ["-C", repoRoot, "worktree", "list", "--porcelain", "-z"]);
  return parseRegisteredWorktrees(stdout).map((registration) => ({
    ...registration,
    // Git for Windows may print slash-separated absolute paths while Node uses
    // platform separators. Syntactic normalization also works after checkout loss.
    path: resolve(registration.path),
  }));
}

async function registeredWorktrees(
  repoRoot: string,
  gitCommonRoot: string,
  hooks: WorktreeCleanupTestHooks = {},
): Promise<RegisteredWorktree[]> {
  return withRepositoryGitMetadataCleanup(gitCommonRoot, () => readRegisteredWorktrees(repoRoot), hooks);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function cleanupIdentityDigest(expected: RuntimeWorktreeIdentity): string {
  return createHash("sha256")
    .update(JSON.stringify(metadataFromRuntimeIdentity(expected)))
    .digest("hex");
}

type CleanupClaimLayout = "direct" | "legacy";

function deterministicQuarantinePaths(
  root: string,
  kind: DirectoryClaimKind,
  expected: RuntimeWorktreeIdentity,
  layout: CleanupClaimLayout = "direct",
): { directory: string; record: string } {
  const digest = cleanupIdentityDigest(expected);
  const stem = layout === "direct" ? `${DIRECT_CLEANUP_CLAIM_PREFIX}-${kind}-cleanup-${digest}` : `.${kind}-${digest}`;
  return { directory: join(root, stem), record: join(root, `${stem}.json`) };
}

async function establishQuarantineRoot(root: string): Promise<string> {
  // A concurrent cleanup can remove a shared empty root after this transaction's
  // initial establishment. Re-establish it through its canonical real parent;
  // never use recursive mkdir, which would follow a replacement symlink.
  const canonicalRoot = await secureChildDirectory(dirname(root), basename(root), true);
  if (canonicalRoot !== root) throw new Error("cleanup quarantine root identity changed");
  return canonicalRoot;
}

function redactQuarantinePath(message: string, quarantinePath: string): string {
  return message.replaceAll(quarantinePath, "<cleanup-quarantine>");
}

function isLegacyCleanupShape(worktree: Worktree): boolean {
  return (
    worktree.isolated &&
    typeof worktree.cwd === "string" &&
    typeof worktree.branch === "string" &&
    worktree.branchRef === undefined &&
    worktree.baseSha === undefined &&
    worktree.cleanupMetadata === undefined
  );
}

function validRegistrationMarker(marker: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(marker);
}

function metadataFromRuntimeIdentity(
  identity: RuntimeWorktreeIdentity,
): WorktreeCleanupMetadataV3 | WorktreeCleanupMetadataV4 {
  const common = {
    registrationMarker: identity.marker,
    repoRoot: identity.repoRoot,
    worktreePath: identity.worktreePath,
    checkoutIdentity: { ...identity.checkoutIdentity },
    branch: identity.branch,
    branchRef: identity.branchRef,
    baseSha: identity.baseSha,
    gitCommonRoot: identity.gitCommonRoot,
    gitDir: identity.gitDir,
  };
  return identity.version === 4 && identity.checkoutProof && identity.gitDirIdentity
    ? {
        version: 4,
        ...common,
        checkoutProof: identity.checkoutProof,
        gitDirIdentity: { ...identity.gitDirIdentity },
        ...(identity.gitDirProof ? { gitDirProof: identity.gitDirProof } : {}),
      }
    : { version: 3, ...common };
}

function parseAnyRegistrationRecord(
  contents: string,
): WorktreeCleanupMetadataV2 | WorktreeCleanupMetadataV3 | WorktreeCleanupMetadataV4 {
  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch {
    throw new Error("registration record is not valid JSON");
  }
  if (!value || typeof value !== "object") throw new Error("registration record is not an object");
  const record = value as Partial<Omit<WorktreeCleanupMetadataV4, "version">> & { version?: 2 | 3 | 4 };
  if (
    (record.version !== 2 && record.version !== 3 && record.version !== 4) ||
    typeof record.registrationMarker !== "string" ||
    !validRegistrationMarker(record.registrationMarker) ||
    typeof record.repoRoot !== "string" ||
    typeof record.worktreePath !== "string" ||
    typeof record.branch !== "string" ||
    typeof record.branchRef !== "string" ||
    typeof record.baseSha !== "string" ||
    typeof record.gitCommonRoot !== "string" ||
    typeof record.gitDir !== "string" ||
    ((record.version === 3 || record.version === 4) &&
      (!record.checkoutIdentity ||
        !/^\d+$/.test(record.checkoutIdentity.dev) ||
        !/^\d+$/.test(record.checkoutIdentity.ino))) ||
    (record.version === 4 &&
      (!record.gitDirIdentity ||
        !/^\d+$/.test(record.gitDirIdentity.dev) ||
        !/^\d+$/.test(record.gitDirIdentity.ino) ||
        !record.checkoutProof ||
        (record.checkoutProof.kind !== "descriptor" && record.checkoutProof.kind !== "sentinel") ||
        (record.checkoutProof.kind === "sentinel" &&
          ((record.checkoutProof.fileName !== LEGACY_CHECKOUT_SENTINEL_FILE &&
            !isCurrentSentinelFileName(record.checkoutProof.fileName)) ||
            !/^[0-9a-f]{64}$/i.test(record.checkoutProof.token) ||
            typeof record.checkoutProof.excludeLeadingNewline !== "boolean" ||
            !record.checkoutProof.excludeIdentity ||
            !/^\d+$/.test(record.checkoutProof.excludeIdentity.dev) ||
            !/^\d+$/.test(record.checkoutProof.excludeIdentity.ino))) ||
        (record.gitDirProof !== undefined &&
          record.gitDirProof.kind !== "descriptor" &&
          (record.gitDirProof.kind !== "sentinel" ||
            !isCurrentGitDirectorySentinelFileName(record.gitDirProof.fileName) ||
            !/^[0-9a-f]{64}$/i.test(record.gitDirProof.token) ||
            !record.gitDirProof.identity ||
            !/^\d+$/.test(record.gitDirProof.identity.dev) ||
            !/^\d+$/.test(record.gitDirProof.identity.ino)))))
  ) {
    throw new Error("registration record is incomplete or has an unsupported version");
  }
  const common = {
    registrationMarker: record.registrationMarker,
    repoRoot: record.repoRoot,
    worktreePath: record.worktreePath,
    branch: record.branch,
    branchRef: record.branchRef,
    baseSha: record.baseSha,
    gitCommonRoot: record.gitCommonRoot,
    gitDir: record.gitDir,
  };
  if (record.version === 4) {
    return {
      version: 4,
      ...common,
      checkoutIdentity: { ...record.checkoutIdentity } as FileIdentity,
      checkoutProof: record.checkoutProof as WorktreeCheckoutProof,
      gitDirIdentity: { ...record.gitDirIdentity } as FileIdentity,
      ...(record.gitDirProof ? { gitDirProof: record.gitDirProof as WorktreeGitDirectoryProof } : {}),
    };
  }
  return record.version === 3
    ? { version: 3, ...common, checkoutIdentity: { ...record.checkoutIdentity } as FileIdentity }
    : { version: 2, ...common };
}

function parseRegistrationRecord(contents: string): WorktreeCleanupMetadataV3 | WorktreeCleanupMetadataV4 {
  const record = parseAnyRegistrationRecord(contents);
  if (record.version !== 3 && record.version !== 4) {
    throw new Error("registration record uses a legacy cleanup identity version");
  }
  return record;
}

async function readRegistrationFile(markerPath: string): Promise<string> {
  const pathStats = await lstat(markerPath, { bigint: true });
  if (pathStats.isSymbolicLink() || !pathStats.isFile()) {
    throw new Error("registration record is not a regular file");
  }
  const handle = await open(markerPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const handleStats = await handle.stat({ bigint: true });
    if (!handleStats.isFile() || !hasFileIdentity(handleStats, fileIdentity(pathStats))) {
      throw new Error("registration record changed while its identity was verified");
    }
    if (handleStats.size > 16_384n) throw new Error("registration record is unexpectedly large");
    return (await handle.readFile({ encoding: "utf8" })).trim();
  } finally {
    await handle.close();
  }
}

async function readRegistrationRecord(gitDir: string): Promise<WorktreeCleanupMetadataV3 | WorktreeCleanupMetadataV4> {
  return parseRegistrationRecord(await readRegistrationFile(join(gitDir, REGISTRATION_MARKER_FILE)));
}

async function writeRegistrationRecord(
  gitDir: string,
  record: WorktreeCleanupMetadataV3 | WorktreeCleanupMetadataV4,
  boundDirectory?: { handle: FileHandle; identity: FileIdentity },
  writeOptions: DescriptorRelativeWriteOptions = {},
): Promise<void> {
  const opened = boundDirectory ?? (await openBoundDirectory(gitDir));
  try {
    await writeExclusiveDescriptorRelative(
      gitDir,
      opened.handle,
      opened.identity,
      REGISTRATION_MARKER_FILE,
      `${JSON.stringify(record)}\n`,
      "registration",
      writeOptions,
    );
  } finally {
    if (!boundDirectory) await opened.handle.close().catch(() => undefined);
  }
}

async function replaceLegacyRegistrationMarker(
  gitDir: string,
  record: WorktreeCleanupMetadataV3 | WorktreeCleanupMetadataV4,
): Promise<void> {
  const directory = await openBoundDirectory(gitDir);
  const replacementName = `.${REGISTRATION_MARKER_FILE}-${randomUUID()}`;
  try {
    const aliasPath = await verifiedDescriptorAlias(directory.handle, directory.identity);
    const markerPath = join(aliasPath, REGISTRATION_MARKER_FILE);
    const replacementPath = join(aliasPath, replacementName);
    try {
      await writeExclusiveDescriptorRelative(
        gitDir,
        directory.handle,
        directory.identity,
        replacementName,
        `${JSON.stringify(record)}\n`,
        "registration",
      );
      const currentMarker = await readRegistrationFile(markerPath);
      if (!validRegistrationMarker(currentMarker) || currentMarker !== record.registrationMarker) {
        throw new Error("legacy registration marker changed before upgrade");
      }
      await rename(replacementPath, markerPath);
    } finally {
      await rm(replacementPath, { force: true }).catch(() => undefined);
    }
  } finally {
    await directory.handle.close().catch(() => undefined);
  }
}

async function replaceRegistrationRecord(
  gitDir: string,
  expectedContents: string,
  record: WorktreeCleanupMetadataV3 | WorktreeCleanupMetadataV4,
): Promise<void> {
  const directory = await openBoundDirectory(gitDir);
  const replacementName = `.${REGISTRATION_MARKER_FILE}-${randomUUID()}`;
  try {
    const aliasPath = await verifiedDescriptorAlias(directory.handle, directory.identity);
    const markerPath = join(aliasPath, REGISTRATION_MARKER_FILE);
    const replacementPath = join(aliasPath, replacementName);
    try {
      await writeExclusiveDescriptorRelative(
        gitDir,
        directory.handle,
        directory.identity,
        replacementName,
        `${JSON.stringify(record)}\n`,
        "registration",
      );
      if ((await readRegistrationFile(markerPath)) !== expectedContents) {
        throw new Error("legacy registration record changed before identity upgrade");
      }
      await rename(replacementPath, markerPath);
    } finally {
      await rm(replacementPath, { force: true }).catch(() => undefined);
    }
  } finally {
    await directory.handle.close().catch(() => undefined);
  }
}

async function installUpgradedCleanupMetadata(
  common: Omit<WorktreeCleanupMetadataV4, "version" | "checkoutProof" | "gitDirIdentity" | "gitDirProof">,
  install: (metadata: WorktreeCleanupMetadataV4) => Promise<void>,
  repositoryLockHeld = false,
  gitDirectoryDescriptorErrorCode?: "EISDIR" | "ENOTSUP",
): Promise<WorktreeCleanupMetadataV4> {
  let handle: FileHandle | undefined;
  let gitDirHandle: FileHandle | undefined;
  let gitDirIdentity: FileIdentity | undefined;
  let gitDirSentinel: Extract<WorktreeGitDirectoryProof, { kind: "sentinel" }> | undefined;
  let proof: WorktreeCheckoutProof | undefined;
  try {
    try {
      handle = await open(common.worktreePath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      const handleStats = await handle.stat({ bigint: true });
      if (!handleStats.isDirectory() || !hasFileIdentity(handleStats, common.checkoutIdentity)) {
        throw new Error("legacy upgrade descriptor does not match the checkout identity");
      }
      proof = { kind: "descriptor" };
    } catch (error) {
      await handle?.close().catch(() => undefined);
      handle = undefined;
      const code = (error as NodeJS.ErrnoException).code;
      if (code && !["EINVAL", "ENOTSUP", "EOPNOTSUPP", "EISDIR", "EPERM"].includes(code)) throw error;
      throw new Error("safe checkout-directory descriptor is unavailable for portable identity upgrade");
    }
    if (!proof) throw new Error("durable checkout proof is unavailable");
    const gitDirectoryOwnership = await createGitDirectoryOwnershipProof(
      common.gitDir,
      gitDirectoryDescriptorErrorCode,
    );
    gitDirHandle = gitDirectoryOwnership.handle;
    gitDirIdentity = gitDirectoryOwnership.identity;
    if (gitDirectoryOwnership.proof.kind === "sentinel") gitDirSentinel = gitDirectoryOwnership.proof;
    const metadata: WorktreeCleanupMetadataV4 = {
      version: 4,
      ...common,
      checkoutProof: proof,
      gitDirIdentity: gitDirectoryOwnership.identity,
      gitDirProof: gitDirectoryOwnership.proof,
    };
    await install(metadata);
    if (handle) {
      const previous = checkoutDirectoryHandles.get(metadata.registrationMarker);
      checkoutDirectoryHandles.set(metadata.registrationMarker, handle);
      if (previous && previous !== handle) await previous.close().catch(() => undefined);
      handle = undefined;
    }
    if (gitDirHandle && gitDirectoryOwnership.proof.kind === "descriptor") {
      const previousGitDir = gitDirectoryHandles.get(metadata.registrationMarker);
      gitDirectoryHandles.set(metadata.registrationMarker, gitDirHandle);
      if (previousGitDir && previousGitDir !== gitDirHandle) await previousGitDir.close().catch(() => undefined);
      gitDirHandle = undefined;
    } else {
      await gitDirHandle?.close().catch(() => undefined);
      gitDirHandle = undefined;
    }
    gitDirSentinel = undefined;
    return metadata;
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await gitDirHandle?.close().catch(() => undefined);
    if (gitDirSentinel) {
      const currentGitDir = await lstat(common.gitDir, { bigint: true }).catch(() => undefined);
      if (currentGitDir?.isDirectory() && gitDirIdentity && hasFileIdentity(currentGitDir, gitDirIdentity)) {
        await rm(join(common.gitDir, gitDirSentinel.fileName), { force: true }).catch(() => undefined);
      }
    }
    if (proof?.kind === "sentinel") {
      await rm(join(common.worktreePath, proof.fileName), { force: true }).catch(() => undefined);
      await removeSentinelExclude(common.gitCommonRoot, common.registrationMarker, proof, {}, repositoryLockHeld).catch(
        () => undefined,
      );
    }
    await closeRuntimeIdentityHandles(common.registrationMarker);
    throw error;
  }
}

interface LegacyAdoptionOptions {
  repositoryLockHeld?: boolean;
  expectedVersionTwo?: WorktreeCleanupMetadataV2;
  expectedVersionThree?: WorktreeCleanupMetadataV3;
  gitDirectoryDescriptorErrorCode?: "EISDIR" | "ENOTSUP";
}

async function adoptLegacyWorktree(
  worktree: Worktree,
  options: LegacyAdoptionOptions = {},
): Promise<Worktree | string> {
  if (!isLegacyCleanupShape(worktree)) return "cloneable worktree cleanup identity is unavailable or incomplete";
  if (!worktree.branch?.startsWith("pi/wf/")) return "legacy branch is outside the runtime worktree namespace";

  try {
    if (!isAbsolute(worktree.cwd) || resolve(worktree.cwd) !== worktree.cwd) {
      return "legacy worktree path is not canonical and absolute";
    }
    const checkoutStats = await lstat(worktree.cwd, { bigint: true });
    if (checkoutStats.isSymbolicLink() || !checkoutStats.isDirectory()) {
      return "legacy worktree path is not a real directory";
    }
    const checkoutIdentity = fileIdentity(checkoutStats);
    const worktreePath = await realpath(worktree.cwd);
    if (worktreePath !== worktree.cwd) return "legacy worktree path is not canonical";

    const preliminaryGitDir = await resolveGitDirectory(worktreePath, "--git-dir");
    let recordedMetadata: WorktreeCleanupMetadataV2 | WorktreeCleanupMetadataV3 | WorktreeCleanupMetadataV4 | undefined;
    try {
      recordedMetadata = parseAnyRegistrationRecord(
        await readRegistrationFile(join(preliminaryGitDir, REGISTRATION_MARKER_FILE)),
      );
    } catch {
      // Pre-v2 legacy registrations may contain only a UUID marker or no marker.
    }

    const directParent = dirname(worktreePath);
    let derivedRepoRoot: string;
    if (isExactPrefixedChild(directParent, worktreePath, RUNTIME_WORKTREE_PREFIX)) {
      if (!recordedMetadata || recordedMetadata.worktreePath !== worktreePath) {
        return "Git-common-dir runtime child has no matching immutable registration record";
      }
      derivedRepoRoot = recordedMetadata.repoRoot;
    } else {
      derivedRepoRoot = isExactLegacyDirectWorktreeChild(directParent, worktreePath)
        ? directParent
        : resolve(worktreePath, "..", "..", "..");
    }
    const repoRoot = await realpath(derivedRepoRoot);
    if (repoRoot !== derivedRepoRoot) return "legacy repository root is not canonical";
    if (worktree.repoRoot !== undefined) {
      if (!isAbsolute(worktree.repoRoot) || resolve(worktree.repoRoot) !== worktree.repoRoot) {
        return "stored legacy repository root is not canonical and absolute";
      }
      const storedRepoRoot = await realpath(worktree.repoRoot);
      if (storedRepoRoot !== repoRoot || storedRepoRoot !== worktree.repoRoot) {
        return "stored legacy repository root does not match the path-derived repository root";
      }
    }

    const [{ stdout: topLevelOutput }, gitCommonRoot, checkoutCommonRoot] = await Promise.all([
      executeGit(["-C", repoRoot, "rev-parse", "--show-toplevel"]),
      resolveGitDirectory(repoRoot, "--git-common-dir"),
      resolveGitDirectory(worktreePath, "--git-common-dir"),
    ]);
    const gitDir = preliminaryGitDir;
    try {
      await verifyRuntimeWorktreeContainment(repoRoot, gitCommonRoot, worktreePath);
    } catch {
      return "legacy worktree path is not an exact runtime direct child or legacy worktree-root child";
    }
    const canonicalTopLevel = await realpath(topLevelOutput.trim());
    if (canonicalTopLevel !== repoRoot) return "legacy repository root is not the exact Git top-level";
    if (checkoutCommonRoot !== gitCommonRoot) return "legacy checkout belongs to a different Git common root";
    const gitDirStats = await lstat(gitDir, { bigint: true });
    if (gitDirStats.isSymbolicLink() || !gitDirStats.isDirectory()) {
      return "legacy per-worktree gitdir is not a real directory";
    }
    const registeredCheckoutLink = resolve((await readFile(join(gitDir, "gitdir"), "utf8")).trim());
    if (registeredCheckoutLink !== join(worktreePath, ".git")) {
      return "legacy per-worktree gitdir points at a different checkout";
    }

    const branchRef = `refs/heads/${worktree.branch}`;
    const registrations = options.repositoryLockHeld
      ? await readRegisteredWorktrees(repoRoot)
      : await registeredWorktrees(repoRoot, gitCommonRoot);
    const registration = registrations.find((candidate) => candidate.path === worktreePath);
    if (!registration || registration.branchRef !== branchRef) {
      return "legacy worktree path and runtime branch are not exactly registered together";
    }
    if (registrations.some((candidate) => candidate.path !== worktreePath && candidate.branchRef === branchRef)) {
      return "legacy temporary branch is checked out by another registered worktree";
    }

    const [{ stdout: refOutput }, { stdout: objectFormatOutput }] = await Promise.all([
      exec("git", ["-C", repoRoot, "for-each-ref", "--format=%(objectname)%00%(symref)", branchRef]),
      exec("git", ["-C", repoRoot, "rev-parse", "--show-object-format"]),
    ]);
    const record = refOutput.trimEnd();
    if (!record) return "legacy temporary branch ref does not exist";
    const [branchOid, symref = ""] = record.split("\0");
    if (symref.length > 0) return "legacy temporary branch ref is symbolic";
    const objectFormat = objectFormatOutput.trim();
    const oidWidth = objectFormat === "sha1" ? 40 : objectFormat === "sha256" ? 64 : undefined;
    if (oidWidth === undefined || branchOid?.length !== oidWidth) {
      return "legacy temporary branch object ID does not match the repository object format";
    }

    const currentCheckoutStats = await lstat(worktreePath, { bigint: true });
    if (
      currentCheckoutStats.isSymbolicLink() ||
      !currentCheckoutStats.isDirectory() ||
      !hasFileIdentity(currentCheckoutStats, checkoutIdentity)
    ) {
      return "legacy checkout identity changed before its durable identity upgrade";
    }

    let cleanupMetadata: WorktreeCleanupMetadataV4;
    const install = (registrationMarker: string, writer: (metadata: WorktreeCleanupMetadataV4) => Promise<void>) =>
      installUpgradedCleanupMetadata(
        {
          registrationMarker,
          repoRoot,
          worktreePath,
          checkoutIdentity,
          branch: worktree.branch as string,
          branchRef,
          baseSha: branchOid,
          gitCommonRoot,
          gitDir,
        },
        writer,
        options.repositoryLockHeld,
        options.gitDirectoryDescriptorErrorCode,
      );
    try {
      const contents = await readRegistrationFile(join(gitDir, REGISTRATION_MARKER_FILE));
      if (validRegistrationMarker(contents)) {
        cleanupMetadata = await install(contents, (metadata) => replaceLegacyRegistrationMarker(gitDir, metadata));
      } else {
        const existing = parseAnyRegistrationRecord(contents);
        if (
          existing.repoRoot !== repoRoot ||
          existing.worktreePath !== worktreePath ||
          existing.branch !== worktree.branch ||
          existing.branchRef !== branchRef ||
          existing.gitCommonRoot !== gitCommonRoot ||
          existing.gitDir !== gitDir
        ) {
          return "legacy worktree does not match its immutable registration record";
        }
        if (existing.version === 3) {
          const expectedV3 = options.expectedVersionThree;
          if (
            !expectedV3 ||
            existing.registrationMarker !== expectedV3.registrationMarker ||
            existing.repoRoot !== expectedV3.repoRoot ||
            existing.worktreePath !== expectedV3.worktreePath ||
            existing.branch !== expectedV3.branch ||
            existing.branchRef !== expectedV3.branchRef ||
            existing.baseSha !== expectedV3.baseSha ||
            existing.gitCommonRoot !== expectedV3.gitCommonRoot ||
            existing.gitDir !== expectedV3.gitDir ||
            !hasFileIdentity(existing.checkoutIdentity, expectedV3.checkoutIdentity) ||
            !hasFileIdentity(currentCheckoutStats, expectedV3.checkoutIdentity)
          ) {
            return "version-three registration cannot be freshly adopted as a legacy worktree";
          }
          const versionThreeIdentity: RuntimeWorktreeIdentity = {
            version: 3,
            repoRoot: expectedV3.repoRoot,
            worktreePath: expectedV3.worktreePath,
            checkoutIdentity: { ...expectedV3.checkoutIdentity },
            branch: expectedV3.branch,
            branchRef: expectedV3.branchRef,
            baseSha: expectedV3.baseSha,
            gitCommonRoot: expectedV3.gitCommonRoot,
            gitDir: expectedV3.gitDir,
            marker: expectedV3.registrationMarker,
          };
          const checkoutProofFailure = await verifyCheckoutOwnershipProof(versionThreeIdentity, currentCheckoutStats);
          if (checkoutProofFailure) {
            return `version-three checkout ownership proof is unavailable: ${checkoutProofFailure}`;
          }
          cleanupMetadata = await install(existing.registrationMarker, (metadata) =>
            replaceRegistrationRecord(gitDir, contents, metadata),
          );
        } else if (existing.version === 4) {
          const expectedV2 = options.expectedVersionTwo;
          const expectedV3 = options.expectedVersionThree;
          const expectedLegacy = expectedV3 ?? expectedV2;
          if (
            !expectedLegacy ||
            existing.registrationMarker !== expectedLegacy.registrationMarker ||
            existing.repoRoot !== expectedLegacy.repoRoot ||
            existing.worktreePath !== expectedLegacy.worktreePath ||
            existing.branch !== expectedLegacy.branch ||
            existing.branchRef !== expectedLegacy.branchRef ||
            existing.gitCommonRoot !== expectedLegacy.gitCommonRoot ||
            existing.gitDir !== expectedLegacy.gitDir ||
            existing.baseSha !== branchOid ||
            (expectedV3 !== undefined && !hasFileIdentity(existing.checkoutIdentity, expectedV3.checkoutIdentity)) ||
            !hasFileIdentity(currentCheckoutStats, existing.checkoutIdentity) ||
            !hasFileIdentity(gitDirStats, existing.gitDirIdentity)
          ) {
            return "current-version registration cannot be freshly adopted as a legacy worktree";
          }
          const upgradedIdentity: RuntimeWorktreeIdentity = {
            version: 4,
            repoRoot: existing.repoRoot,
            worktreePath: existing.worktreePath,
            checkoutIdentity: { ...existing.checkoutIdentity },
            checkoutProof: existing.checkoutProof,
            gitDirIdentity: { ...existing.gitDirIdentity },
            ...(existing.gitDirProof ? { gitDirProof: existing.gitDirProof } : {}),
            branch: existing.branch,
            branchRef: existing.branchRef,
            baseSha: existing.baseSha,
            gitCommonRoot: existing.gitCommonRoot,
            gitDir: existing.gitDir,
            marker: existing.registrationMarker,
          };
          const [checkoutProofFailure, gitDirProofFailure] = await Promise.all([
            verifyCheckoutOwnershipProof(upgradedIdentity, currentCheckoutStats),
            verifyGitDirectoryOwnershipProof(upgradedIdentity, gitDirStats),
          ]);
          if (checkoutProofFailure || gitDirProofFailure) {
            return "upgraded legacy registration no longer has its exact runtime ownership proofs";
          }
          cleanupMetadata = existing;
        } else {
          cleanupMetadata = await install(existing.registrationMarker, (metadata) =>
            replaceRegistrationRecord(gitDir, contents, metadata),
          );
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      cleanupMetadata = await install(randomUUID(), (metadata) => writeRegistrationRecord(gitDir, metadata));
    }
    return {
      ...worktree,
      cwd: worktreePath,
      branchRef,
      baseSha: cleanupMetadata.baseSha,
      repoRoot,
      cleanupMetadata,
    };
  } catch (error) {
    return `legacy worktree adoption failed: ${errorMessage(error)}`;
  }
}

async function upgradeVersionOneWorktree(worktree: Worktree): Promise<Worktree | string> {
  const metadata = worktree.cleanupMetadata;
  if (
    metadata?.version !== 1 ||
    !worktree.repoRoot ||
    !worktree.branch ||
    !worktree.branchRef ||
    !worktree.baseSha ||
    worktree.branchRef !== `refs/heads/${worktree.branch}`
  ) {
    return "legacy cloneable worktree cleanup identity is unavailable or incomplete";
  }
  const adopted = await adoptLegacyWorktree({
    isolated: true,
    cwd: worktree.cwd,
    branch: worktree.branch,
    repoRoot: worktree.repoRoot,
  });
  if (typeof adopted === "string") return adopted;
  const adoptedMetadata = adopted.cleanupMetadata;
  if (
    adoptedMetadata?.version !== 4 ||
    adoptedMetadata.registrationMarker !== metadata.registrationMarker ||
    adoptedMetadata.gitCommonRoot !== metadata.gitCommonRoot ||
    adoptedMetadata.gitDir !== metadata.gitDir
  ) {
    return "legacy cloneable metadata does not match its registered worktree identity";
  }
  return adopted;
}

async function upgradeVersionTwoWorktree(worktree: Worktree): Promise<Worktree | string> {
  const metadata = worktree.cleanupMetadata;
  if (
    metadata?.version !== 2 ||
    !worktree.repoRoot ||
    !worktree.branch ||
    !worktree.branchRef ||
    !worktree.baseSha ||
    worktree.branchRef !== `refs/heads/${worktree.branch}`
  ) {
    return "legacy version-two worktree cleanup identity is unavailable or incomplete";
  }
  if (
    worktree.cwd !== metadata.worktreePath ||
    worktree.repoRoot !== metadata.repoRoot ||
    worktree.branch !== metadata.branch ||
    worktree.branchRef !== metadata.branchRef ||
    worktree.baseSha !== metadata.baseSha
  ) {
    return "legacy version-two worktree fields do not match their serialized cleanup identity";
  }
  let actualGitCommonRoot: string;
  try {
    actualGitCommonRoot = await resolveGitDirectory(worktree.cwd, "--git-common-dir");
    if (
      actualGitCommonRoot !== metadata.gitCommonRoot ||
      (await realDirectory(actualGitCommonRoot, false)) !== actualGitCommonRoot
    ) {
      return "legacy version-two Git common root does not match its registered repository";
    }
  } catch (error) {
    return `legacy version-two repository validation failed: ${errorMessage(error)}`;
  }
  return withRepositoryGitMetadataCleanup(actualGitCommonRoot, async () => {
    const adopted = await adoptLegacyWorktree(
      {
        isolated: true,
        cwd: worktree.cwd,
        branch: worktree.branch,
        repoRoot: worktree.repoRoot,
      },
      { repositoryLockHeld: true, expectedVersionTwo: metadata },
    );
    if (typeof adopted === "string") return adopted;
    const adoptedMetadata = adopted.cleanupMetadata;
    if (
      adoptedMetadata?.version !== 4 ||
      adoptedMetadata.registrationMarker !== metadata.registrationMarker ||
      adoptedMetadata.repoRoot !== metadata.repoRoot ||
      adoptedMetadata.worktreePath !== metadata.worktreePath ||
      adoptedMetadata.branchRef !== metadata.branchRef ||
      adoptedMetadata.gitCommonRoot !== metadata.gitCommonRoot ||
      adoptedMetadata.gitDir !== metadata.gitDir
    ) {
      return "legacy version-two metadata does not match its registered worktree identity";
    }
    return adopted;
  });
}

async function upgradeVersionThreeWorktree(
  worktree: Worktree,
  hooks: WorktreeCleanupTestHooks,
): Promise<Worktree | string> {
  const metadata = worktree.cleanupMetadata;
  if (
    metadata?.version !== 3 ||
    !worktree.repoRoot ||
    !worktree.branch ||
    !worktree.branchRef ||
    !worktree.baseSha ||
    worktree.branchRef !== `refs/heads/${worktree.branch}`
  ) {
    return "legacy version-three worktree cleanup identity is unavailable or incomplete";
  }
  if (
    worktree.cwd !== metadata.worktreePath ||
    worktree.repoRoot !== metadata.repoRoot ||
    worktree.branch !== metadata.branch ||
    worktree.branchRef !== metadata.branchRef ||
    worktree.baseSha !== metadata.baseSha
  ) {
    return "legacy version-three worktree fields do not match their serialized cleanup identity";
  }

  let actualGitCommonRoot: string;
  try {
    actualGitCommonRoot = await resolveGitDirectory(worktree.cwd, "--git-common-dir");
    if (
      actualGitCommonRoot !== metadata.gitCommonRoot ||
      (await realDirectory(actualGitCommonRoot, false)) !== actualGitCommonRoot
    ) {
      return "legacy version-three Git common root does not match its registered repository";
    }
  } catch (error) {
    return `legacy version-three repository validation failed: ${errorMessage(error)}`;
  }

  return withRepositoryGitMetadataCleanup(actualGitCommonRoot, async () => {
    const adopted = await adoptLegacyWorktree(
      {
        isolated: true,
        cwd: worktree.cwd,
        branch: worktree.branch,
        repoRoot: worktree.repoRoot,
      },
      {
        repositoryLockHeld: true,
        expectedVersionThree: metadata,
        gitDirectoryDescriptorErrorCode: hooks.gitDirectoryDescriptorErrorCode,
      },
    );
    if (typeof adopted === "string") return adopted;
    const adoptedMetadata = adopted.cleanupMetadata;
    if (
      adoptedMetadata?.version !== 4 ||
      adoptedMetadata.registrationMarker !== metadata.registrationMarker ||
      adoptedMetadata.repoRoot !== metadata.repoRoot ||
      adoptedMetadata.worktreePath !== metadata.worktreePath ||
      !hasFileIdentity(adoptedMetadata.checkoutIdentity, metadata.checkoutIdentity) ||
      adoptedMetadata.branch !== metadata.branch ||
      adoptedMetadata.branchRef !== metadata.branchRef ||
      adoptedMetadata.gitCommonRoot !== metadata.gitCommonRoot ||
      adoptedMetadata.gitDir !== metadata.gitDir
    ) {
      return "legacy version-three metadata does not match its registered worktree identity";
    }
    return adopted;
  });
}

function runtimeIdentity(worktree: Worktree): RuntimeWorktreeIdentity | string {
  const metadata = worktree.cleanupMetadata;
  if (
    (metadata?.version !== 3 && metadata?.version !== 4) ||
    !metadata.repoRoot ||
    !metadata.worktreePath ||
    !metadata.branch ||
    !metadata.branchRef ||
    !metadata.baseSha ||
    !metadata.gitCommonRoot ||
    !metadata.gitDir ||
    !metadata.registrationMarker ||
    (metadata.version === 4 && !metadata.gitDirIdentity)
  ) {
    return "cloneable worktree cleanup identity is unavailable or incomplete";
  }
  return {
    version: metadata.version,
    repoRoot: metadata.repoRoot,
    worktreePath: metadata.worktreePath,
    checkoutIdentity: { ...metadata.checkoutIdentity },
    ...(metadata.version === 4
      ? {
          checkoutProof: metadata.checkoutProof,
          gitDirIdentity: { ...metadata.gitDirIdentity },
          ...(metadata.gitDirProof ? { gitDirProof: metadata.gitDirProof } : {}),
        }
      : {}),
    branch: metadata.branch,
    branchRef: metadata.branchRef,
    baseSha: metadata.baseSha,
    gitCommonRoot: metadata.gitCommonRoot,
    gitDir: metadata.gitDir,
    marker: metadata.registrationMarker,
  };
}

function callerMatchesRuntimeIdentity(worktree: Worktree, expected: RuntimeWorktreeIdentity): boolean {
  return (
    worktree.repoRoot === expected.repoRoot &&
    worktree.cwd === expected.worktreePath &&
    worktree.branch === expected.branch &&
    worktree.branchRef === expected.branchRef &&
    worktree.baseSha === expected.baseSha
  );
}

function runtimeIdentityKey(worktree: Worktree): string | undefined {
  const identity = runtimeIdentity(worktree);
  if (typeof identity === "string") return undefined;
  return createHash("sha256").update(JSON.stringify(identity)).digest("hex");
}

async function verifyCheckoutOwnershipProof(
  expected: RuntimeWorktreeIdentity,
  checkoutStats: { isDirectory(): boolean; dev: number | bigint; ino: number | bigint },
  checkoutPath = expected.worktreePath,
): Promise<string | undefined> {
  const handle = checkoutDirectoryHandles.get(expected.marker);
  if (handle) {
    try {
      const handleStats = await handle.stat({ bigint: true });
      if (
        !handleStats.isDirectory() ||
        !hasFileIdentity(handleStats, expected.checkoutIdentity) ||
        !hasFileIdentity(checkoutStats, fileIdentity(handleStats))
      ) {
        return "process-local checkout descriptor no longer matches the registered pathname identity";
      }
      return undefined;
    } catch {
      return "process-local checkout descriptor could not be verified";
    }
  }

  if (expected.version !== 4 || expected.checkoutProof?.kind !== "sentinel") {
    return "process-local checkout descriptor is unavailable for current-version cleanup";
  }
  try {
    const sentinel = await readRegistrationFile(join(checkoutPath, expected.checkoutProof.fileName));
    if (sentinel !== expected.checkoutProof.token) return "checkout-local ownership sentinel does not match";
    return undefined;
  } catch {
    return "checkout-local ownership sentinel is unavailable or invalid";
  }
}

async function verifyGitDirectoryOwnershipProof(
  expected: RuntimeWorktreeIdentity,
  gitDirStats: { isDirectory(): boolean; dev: number | bigint; ino: number | bigint },
  simulateReusedIdentity = false,
): Promise<string | undefined> {
  const handle = gitDirectoryHandles.get(expected.marker);
  if (expected.version !== 4 || !expected.gitDirIdentity) {
    return "Git registration ownership proof is unavailable for current-version cleanup";
  }
  if (handle) {
    try {
      const handleStats = await handle.stat({ bigint: true });
      if (
        !gitDirStats.isDirectory() ||
        !handleStats.isDirectory() ||
        (!simulateReusedIdentity && !hasFileIdentity(gitDirStats, expected.gitDirIdentity)) ||
        !hasFileIdentity(handleStats, expected.gitDirIdentity) ||
        !hasFileIdentity(gitDirStats, fileIdentity(handleStats))
      ) {
        return "process-local Git registration descriptor no longer matches the original pathname identity";
      }
      return undefined;
    } catch {
      return "process-local Git registration descriptor could not be verified";
    }
  }

  const proof = expected.gitDirProof;
  if (proof?.kind !== "sentinel") {
    return "process-local Git registration descriptor is unavailable for current-version cleanup";
  }
  try {
    if (
      !gitDirStats.isDirectory() ||
      (!simulateReusedIdentity && !hasFileIdentity(gitDirStats, expected.gitDirIdentity))
    ) {
      return "portable Git registration path no longer matches its original identity";
    }
    const sentinelPath = join(expected.gitDir, proof.fileName);
    const sentinelStats = await lstat(sentinelPath, { bigint: true });
    if (
      sentinelStats.isSymbolicLink() ||
      !sentinelStats.isFile() ||
      !hasFileIdentity(sentinelStats, proof.identity) ||
      (await readRegistrationFile(sentinelPath)) !== proof.token
    ) {
      return "portable Git registration sentinel does not match its persisted identity";
    }
    return undefined;
  } catch {
    return "portable Git registration sentinel is unavailable or invalid";
  }
}

async function locateDescriptorProvenRenamedCheckout(expected: RuntimeWorktreeIdentity): Promise<string | undefined> {
  const handle = checkoutDirectoryHandles.get(expected.marker);
  if (!handle) return undefined;
  const handleStats = await handle.stat({ bigint: true });
  if (!handleStats.isDirectory() || !hasFileIdentity(handleStats, expected.checkoutIdentity)) {
    throw new Error("process-local checkout descriptor no longer matches the registered identity");
  }
  if (handleStats.nlink === 0n) return undefined;

  const canonicalParent = await realDirectory(expected.gitCommonRoot, false);
  if (canonicalParent !== expected.gitCommonRoot) throw new Error("Git common parent is not canonical");
  const matches: string[] = [];
  for (const entry of await readdir(canonicalParent, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const candidate = join(canonicalParent, entry.name);
    try {
      const candidateStats = await lstat(candidate, { bigint: true });
      if (
        candidateStats.isDirectory() &&
        !candidateStats.isSymbolicLink() &&
        hasFileIdentity(candidateStats, expected.checkoutIdentity) &&
        (await realpath(candidate)) === candidate
      ) {
        matches.push(candidate);
      }
    } catch {
      // Concurrently changing unrelated direct children are not cleanup authority.
    }
  }
  if (matches.length === 1) return matches[0];
  throw new Error(
    matches.length === 0
      ? "descriptor-proven checkout remains linked outside the safe Git-common parent or is unlocatable"
      : "descriptor-proven checkout has multiple safe-parent directory links",
  );
}

async function locateCreationRecoveryCheckout(expected: RuntimeWorktreeIdentity): Promise<string | undefined> {
  const canonicalParent = await realDirectory(expected.gitCommonRoot, false);
  if (canonicalParent !== expected.gitCommonRoot) throw new Error("Git common parent is not canonical");
  const matches: string[] = [];
  for (const entry of await readdir(canonicalParent, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const candidate = join(canonicalParent, entry.name);
    try {
      const stats = await lstat(candidate, { bigint: true });
      if (
        stats.isDirectory() &&
        hasFileIdentity(stats, expected.checkoutIdentity) &&
        (await realpath(candidate)) === candidate &&
        (await verifyCheckoutOwnershipProof(expected, stats, candidate)) === undefined
      ) {
        matches.push(candidate);
      }
    } catch {
      // Unrelated or concurrently changing direct children are not recovery authority.
    }
  }
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) throw new Error("multiple checkout paths match the held creation identity");
  return undefined;
}

async function verifyCleanupIdentity(
  worktree: Worktree,
  hooks: WorktreeCleanupTestHooks = {},
  creationAuthority?: CreationRegistrationAuthority,
): Promise<VerifiedCleanupIdentity | string> {
  const expected = runtimeIdentity(worktree);
  if (typeof expected === "string") return expected;
  if (!expected.branch.startsWith("pi/wf/") || expected.branchRef !== `refs/heads/${expected.branch}`) {
    return "expected branch is outside the runtime worktree namespace";
  }
  if (!callerMatchesRuntimeIdentity(worktree, expected)) {
    return "stored worktree identity no longer matches its cleanup metadata";
  }

  try {
    const canonicalRepoRoot = await realpath(expected.repoRoot);
    if (canonicalRepoRoot !== expected.repoRoot) return "stored repository root is not canonical";
    try {
      await verifyRuntimeWorktreeContainment(canonicalRepoRoot, expected.gitCommonRoot, expected.worktreePath);
    } catch {
      return "runtime worktree path is outside the trusted runtime locations";
    }

    const registrations = await registeredWorktrees(canonicalRepoRoot, expected.gitCommonRoot, hooks);
    const registration = registrations.find((candidate) => candidate.path === expected.worktreePath);
    if (!registration) return "exact canonical worktree path is no longer registered";
    if (
      registrations.some(
        (candidate) => candidate.path !== expected.worktreePath && candidate.branchRef === expected.branchRef,
      )
    ) {
      return "temporary branch is checked out by another registered worktree";
    }

    const actualCommonRoot = await resolveGitDirectory(canonicalRepoRoot, "--git-common-dir");
    if (actualCommonRoot !== expected.gitCommonRoot) {
      return "registered worktree belongs to a different repository common root";
    }

    const gitDirStats = await lstat(expected.gitDir, { bigint: true });
    if (gitDirStats.isSymbolicLink() || !gitDirStats.isDirectory()) {
      return "per-worktree gitdir is not the original real directory";
    }
    const gitDirProofFailure = await verifyGitDirectoryOwnershipProof(
      expected,
      gitDirStats,
      hooks.simulateReusedGitDirIdentity,
    );
    if (gitDirProofFailure) return gitDirProofFailure;
    const actualGitDir = await realpath(expected.gitDir);
    if (actualGitDir !== expected.gitDir) return "per-worktree gitdir identity no longer matches cleanup identity";
    if (expected.checkoutProof?.kind === "sentinel") {
      try {
        await verifiedSentinelExcludeHandle(
          expected.gitCommonRoot,
          expected.marker,
          expected.checkoutProof,
          hooks.simulateReusedExcludeIdentity,
        );
      } catch (error) {
        return `portable sentinel exclude identity no longer matches cleanup identity: ${errorMessage(error)}`;
      }
    }
    if (creationAuthority !== "in-memory") {
      const registrationRecord = await readRegistrationRecord(actualGitDir);
      const recordedIdentity: RuntimeWorktreeIdentity = {
        version: registrationRecord.version,
        repoRoot: registrationRecord.repoRoot,
        worktreePath: registrationRecord.worktreePath,
        checkoutIdentity: { ...registrationRecord.checkoutIdentity },
        ...(registrationRecord.version === 4
          ? {
              checkoutProof: registrationRecord.checkoutProof,
              gitDirIdentity: { ...registrationRecord.gitDirIdentity },
              ...(registrationRecord.gitDirProof ? { gitDirProof: registrationRecord.gitDirProof } : {}),
            }
          : {}),
        branch: registrationRecord.branch,
        branchRef: registrationRecord.branchRef,
        baseSha: registrationRecord.baseSha,
        gitCommonRoot: registrationRecord.gitCommonRoot,
        gitDir: registrationRecord.gitDir,
        marker: registrationRecord.registrationMarker,
      };
      if (!sameRuntimeIdentity(recordedIdentity, expected)) {
        return "per-worktree registration record does not match cleanup metadata";
      }
    }
    const registeredCheckoutLink = resolve((await readFile(join(actualGitDir, "gitdir"), "utf8")).trim());
    if (registeredCheckoutLink !== join(expected.worktreePath, ".git")) {
      return "per-worktree gitdir points at a different checkout";
    }
    const [{ stdout: branchOutput }, { stdout: objectFormatOutput }] = await Promise.all([
      exec("git", ["-C", canonicalRepoRoot, "rev-parse", "--verify", expected.branchRef]),
      exec("git", ["-C", canonicalRepoRoot, "rev-parse", "--show-object-format"]),
    ]);
    const objectFormat = objectFormatOutput.trim();
    const oidWidth = objectFormat === "sha1" ? 40 : objectFormat === "sha256" ? 64 : undefined;
    if (oidWidth === undefined) return `unsupported Git object format: ${objectFormat}`;
    const branchOid = branchOutput.trim();
    if (branchOid.length !== oidWidth) return "branch object ID width does not match the repository object format";

    let checkoutIdentity: FileIdentity | undefined;
    let checkoutPath: string | undefined;
    try {
      const checkoutStats = await lstat(expected.worktreePath, { bigint: true });
      const exactCheckout =
        !checkoutStats.isSymbolicLink() &&
        checkoutStats.isDirectory() &&
        (hooks.simulateReusedCheckoutIdentity || hasFileIdentity(checkoutStats, expected.checkoutIdentity)) &&
        (await verifyCheckoutOwnershipProof(expected, checkoutStats)) === undefined;
      if (exactCheckout) {
        const canonicalRegisteredPath = await realpath(registration.path);
        if (canonicalRegisteredPath !== expected.worktreePath) {
          return "registered worktree path is no longer canonical-equivalent";
        }
        checkoutIdentity = { ...expected.checkoutIdentity };
        checkoutPath = expected.worktreePath;
        const [checkoutCommonRoot, checkoutGitDir] = await Promise.all([
          resolveGitDirectory(canonicalRegisteredPath, "--git-common-dir"),
          resolveGitDirectory(canonicalRegisteredPath, "--git-dir"),
        ]);
        if (checkoutCommonRoot !== expected.gitCommonRoot) {
          return "registered checkout belongs to a different repository common root";
        }
        if (checkoutGitDir !== expected.gitDir) return "registered checkout uses a different per-worktree gitdir";
      } else if (creationAuthority) {
        const relocated = await locateCreationRecoveryCheckout(expected);
        if (!relocated) return "held creation checkout identity is no longer available for rollback";
        checkoutIdentity = { ...expected.checkoutIdentity };
        checkoutPath = relocated;
      } else {
        return "registered checkout no longer has the runtime-created filesystem identity and proof";
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const renamedPath = creationAuthority
        ? await locateCreationRecoveryCheckout(expected)
        : await locateDescriptorProvenRenamedCheckout(expected);
      if (renamedPath) {
        const renamedStats = await lstat(renamedPath, { bigint: true });
        const proofFailure = await verifyCheckoutOwnershipProof(expected, renamedStats, renamedPath);
        if (proofFailure) return proofFailure;
        checkoutIdentity = { ...expected.checkoutIdentity };
        checkoutPath = renamedPath;
      }
    }

    return {
      expected,
      checkoutIdentity,
      checkoutPath,
      gitDirIdentity: fileIdentity(gitDirStats),
      branchOid,
      nullOid: "0".repeat(oidWidth),
    };
  } catch (error) {
    return `worktree identity verification failed: ${errorMessage(error)}`;
  }
}

interface ClaimedDirectory {
  path: string;
  quarantineRoot: string;
  sourcePath: string;
  pendingRecordPath?: string;
  handle?: FileHandle;
  identity: FileIdentity;
  restorable: boolean;
  /** Legacy shared roots are removed when empty; the trusted Git-common parent never is. */
  removeParentWhenEmpty?: boolean;
}

interface PendingCleanupRecordV1 {
  version: typeof PENDING_CLEANUP_RECORD_VERSION;
  kind: DirectoryClaimKind;
  state: "claimed" | "destructive";
  identity: FileIdentity;
  metadata: WorktreeCleanupMetadataV3 | WorktreeCleanupMetadataV4;
}

function parsePendingCleanupRecord(contents: string): PendingCleanupRecordV1 {
  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch {
    throw new Error("pending cleanup record is not valid JSON");
  }
  if (!value || typeof value !== "object") throw new Error("pending cleanup record is not an object");
  const record = value as Partial<PendingCleanupRecordV1>;
  if (
    record.version !== PENDING_CLEANUP_RECORD_VERSION ||
    (record.kind !== "checkout" && record.kind !== "registration") ||
    (record.state !== "claimed" && record.state !== "destructive") ||
    !record.identity ||
    typeof record.identity.dev !== "string" ||
    !/^\d+$/.test(record.identity.dev) ||
    typeof record.identity.ino !== "string" ||
    !/^\d+$/.test(record.identity.ino) ||
    !record.metadata
  ) {
    throw new Error("pending cleanup record is incomplete or has an unsupported version");
  }
  const metadata = parseRegistrationRecord(JSON.stringify(record.metadata));
  return {
    version: PENDING_CLEANUP_RECORD_VERSION,
    kind: record.kind,
    state: record.state,
    identity: record.identity,
    metadata,
  };
}

async function writePendingCleanupRecord(
  path: string,
  kind: DirectoryClaimKind,
  identity: FileIdentity,
  expected: RuntimeWorktreeIdentity,
): Promise<void> {
  const record: PendingCleanupRecordV1 = {
    version: PENDING_CLEANUP_RECORD_VERSION,
    kind,
    state: "claimed",
    identity,
    metadata: metadataFromRuntimeIdentity(expected),
  };
  await writeFile(path, `${JSON.stringify(record)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
}

async function markPendingCleanupDestructive(claimed: ClaimedDirectory): Promise<void> {
  if (!claimed.pendingRecordPath) return;
  const current = parsePendingCleanupRecord(await readRegistrationFile(claimed.pendingRecordPath));
  if (current.state === "destructive") return;
  const replacement = join(claimed.quarantineRoot, `.pending-state-${randomUUID()}`);
  await writeFile(replacement, `${JSON.stringify({ ...current, state: "destructive" })}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  try {
    const unchanged = parsePendingCleanupRecord(await readRegistrationFile(claimed.pendingRecordPath));
    if (
      unchanged.state !== "claimed" ||
      unchanged.kind !== current.kind ||
      unchanged.identity.dev !== current.identity.dev ||
      unchanged.identity.ino !== current.identity.ino
    ) {
      throw new Error("pending cleanup identity changed before destructive transition");
    }
    await rename(replacement, claimed.pendingRecordPath);
  } finally {
    await rm(replacement, { force: true }).catch(() => undefined);
  }
}

async function removeEmptyQuarantineRoot(root: string): Promise<void> {
  await rmdir(root).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT" && error.code !== "ENOTEMPTY" && error.code !== "EEXIST") throw error;
  });
}

async function restoreClaimedDirectory(claimed: ClaimedDirectory, label: string): Promise<string> {
  await claimed.handle?.close().catch(() => undefined);
  claimed.handle = undefined;
  if (!claimed.restorable) {
    return `${label} claim was preserved in private quarantine because destructive cleanup had already started`;
  }
  try {
    const claimedStats = await lstat(claimed.path, { bigint: true });
    if (!claimedStats.isDirectory() || !hasFileIdentity(claimedStats, claimed.identity)) {
      return `${label} claim was preserved because its quarantine path no longer names the claimed identity`;
    }
    if (await pathExists(claimed.sourcePath)) {
      return `${label} claim and the occupied original path were both preserved`;
    }
    await rename(claimed.path, claimed.sourcePath);
    const restoredStats = await lstat(claimed.sourcePath, { bigint: true });
    if (!restoredStats.isDirectory() || !hasFileIdentity(restoredStats, claimed.identity)) {
      return `${label} restoration could not be identity-verified; cleanup stopped`;
    }
    if (claimed.pendingRecordPath) await rm(claimed.pendingRecordPath, { force: true });
    if (claimed.removeParentWhenEmpty) await removeEmptyQuarantineRoot(claimed.quarantineRoot);
    return `${label} claim was restored to its original path`;
  } catch (error) {
    const redacted = redactQuarantinePath(
      redactQuarantinePath(errorMessage(error), claimed.path),
      claimed.quarantineRoot,
    );
    return `${label} claim was preserved in private quarantine because restoration failed: ${redacted}`;
  }
}

async function restoreUnexpectedClaim(
  sourcePath: string,
  quarantinePath: string,
  capturedIdentity: FileIdentity,
): Promise<string> {
  if (await pathExists(sourcePath)) {
    return "cleanup claim captured a replacement inode; the occupied original path and captured replacement were preserved";
  }
  try {
    await rename(quarantinePath, sourcePath);
    const restoredStats = await lstat(sourcePath, { bigint: true });
    if (!restoredStats.isDirectory() || !hasFileIdentity(restoredStats, capturedIdentity)) {
      return "cleanup claim captured a replacement inode; restoration could not be verified and cleanup stopped";
    }
    return "cleanup claim captured a replacement inode; the replacement was restored to the original path";
  } catch (error) {
    return `cleanup claim captured a replacement inode; it was preserved in private quarantine because restoration failed: ${redactQuarantinePath(errorMessage(error), quarantinePath)}`;
  }
}

async function claimDirectory(
  worktree: Worktree,
  kind: DirectoryClaimKind,
  sourcePath: string,
  quarantineRoot: string,
  _prefix: string,
  expectedIdentity: FileIdentity,
  hooks: WorktreeCleanupTestHooks,
  layout: CleanupClaimLayout = "direct",
): Promise<ClaimedDirectory | string> {
  const expected = runtimeIdentity(worktree);
  if (typeof expected === "string") return expected;
  const canonicalRoot =
    layout === "direct" ? await realDirectory(quarantineRoot, false) : await establishQuarantineRoot(quarantineRoot);
  if (layout === "direct" && canonicalRoot !== expected.gitCommonRoot) {
    return "current cleanup claim parent is not the exact trusted Git common directory";
  }
  const pendingPaths = deterministicQuarantinePaths(canonicalRoot, kind, expected, layout);
  const quarantinePath = pendingPaths.directory;
  const requiredPrefix = `${DIRECT_CLEANUP_CLAIM_PREFIX}-${kind}-cleanup-`;
  if (layout === "direct" && !isExactPrefixedChild(canonicalRoot, quarantinePath, requiredPrefix)) {
    return "current cleanup claim is not a strict direct child of the Git common directory";
  }
  let renamed = false;
  try {
    if ((await pathExists(quarantinePath)) || (await pathExists(pendingPaths.record))) {
      throw new Error("a deterministic pending cleanup claim already exists and must be resumed first");
    }
    await hooks.beforeDirectoryClaim?.(worktree, kind, sourcePath);
    if ((await pathExists(quarantinePath)) || (await pathExists(pendingPaths.record))) {
      throw new Error("a deterministic cleanup claim collision appeared before rename");
    }
    await rename(sourcePath, quarantinePath);
    renamed = true;
    await hooks.afterDirectoryRename?.(worktree, kind, sourcePath);
  } catch (error) {
    let restoration = "";
    if (renamed) {
      restoration = `; ${await restoreClaimedDirectory(
        {
          path: quarantinePath,
          quarantineRoot,
          sourcePath,
          identity: expectedIdentity,
          restorable: true,
          removeParentWhenEmpty: layout === "legacy",
        },
        kind,
      )}`;
    }
    return `cleanup claim failed: ${redactQuarantinePath(errorMessage(error), quarantinePath || quarantineRoot)}${restoration}`;
  }

  let claimedStats: Awaited<ReturnType<typeof lstat>>;
  try {
    claimedStats = await lstat(quarantinePath, { bigint: true });
  } catch (error) {
    const restoration = await restoreClaimedDirectory(
      {
        path: quarantinePath,
        quarantineRoot,
        sourcePath,
        identity: expectedIdentity,
        restorable: true,
        removeParentWhenEmpty: layout === "legacy",
      },
      kind,
    );
    return `cleanup claim verification failed: ${redactQuarantinePath(errorMessage(error), quarantinePath)}; ${restoration}`;
  }
  if (!claimedStats.isDirectory() || !hasFileIdentity(claimedStats, expectedIdentity)) {
    return restoreUnexpectedClaim(sourcePath, quarantinePath, fileIdentity(claimedStats));
  }

  let handle: FileHandle | undefined;
  try {
    handle = await open(quarantinePath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const handleStats = await handle.stat({ bigint: true });
    if (!handleStats.isDirectory() || !hasFileIdentity(handleStats, expectedIdentity)) {
      await handle.close();
      return restoreUnexpectedClaim(sourcePath, quarantinePath, fileIdentity(handleStats));
    }
  } catch {
    // Directory descriptors are only a Linux race-hardening optimization. The
    // portable path below rechecks the claimed inode before every destructive step.
    await handle?.close().catch(() => undefined);
    handle = undefined;
  }
  const claimed: ClaimedDirectory = {
    path: quarantinePath,
    quarantineRoot,
    sourcePath,
    pendingRecordPath: pendingPaths.record,
    handle,
    identity: expectedIdentity,
    restorable: true,
    removeParentWhenEmpty: layout === "legacy",
  };
  try {
    await writePendingCleanupRecord(pendingPaths.record, kind, expectedIdentity, expected);
  } catch (error) {
    const restoration = await restoreClaimedDirectory(claimed, kind);
    return `cleanup pending identity creation failed: ${redactQuarantinePath(errorMessage(error), pendingPaths.record)}; ${restoration}`;
  }
  return claimed;
}

async function verifiedClaimPath(
  claimed: ClaimedDirectory,
  hooks: WorktreeCleanupTestHooks,
): Promise<{ accessPath: string; removalPath: string }> {
  if (claimed.handle) {
    try {
      const descriptorPath = join(hooks.procDescriptorRoot ?? "/proc/self/fd", String(claimed.handle.fd));
      const [handleStats, descriptorStats, removalPath] = await Promise.all([
        claimed.handle.stat({ bigint: true }),
        stat(descriptorPath, { bigint: true }),
        realpath(descriptorPath),
      ]);
      if (
        handleStats.isDirectory() &&
        hasFileIdentity(handleStats, claimed.identity) &&
        hasFileIdentity(descriptorStats, claimed.identity)
      ) {
        return { accessPath: descriptorPath, removalPath };
      }
    } catch {
      // Fall through to portable path identity checks when /proc is absent.
    }
  }
  const claimedStats = await lstat(claimed.path, { bigint: true });
  if (!claimedStats.isDirectory() || !hasFileIdentity(claimedStats, claimed.identity)) {
    throw new Error("claimed directory path now names a replacement inode; contents were preserved");
  }
  return { accessPath: claimed.path, removalPath: claimed.path };
}

async function verifyClaimStillOwned(claimed: ClaimedDirectory, accessPath: string): Promise<void> {
  const [pathStats, handleStats] = await Promise.all([
    stat(accessPath),
    claimed.handle?.stat({ bigint: true }) ?? Promise.resolve(undefined),
  ]);
  if (
    !pathStats.isDirectory() ||
    !hasFileIdentity(pathStats, claimed.identity) ||
    (handleStats !== undefined && (!handleStats.isDirectory() || !hasFileIdentity(handleStats, claimed.identity)))
  ) {
    throw new Error("claimed directory identity changed; contents were preserved");
  }
}

async function readClaimedFile(
  claimed: ClaimedDirectory,
  fileName: string,
  hooks: WorktreeCleanupTestHooks,
): Promise<string> {
  const { accessPath } = await verifiedClaimPath(claimed, hooks);
  await verifyClaimStillOwned(claimed, accessPath);
  return readFile(join(accessPath, fileName), "utf8");
}

async function cleanupClaimedContents(
  worktree: Worktree,
  kind: DirectoryClaimKind,
  claimed: ClaimedDirectory,
  hooks: WorktreeCleanupTestHooks,
  beforeDestructive?: () => Promise<void>,
): Promise<string | undefined> {
  let removalPath = claimed.path;
  try {
    await hooks.beforeClaimedContentsCleanup?.(worktree, kind);
    const verifiedPath = await verifiedClaimPath(claimed, hooks);
    removalPath = verifiedPath.removalPath;
    const entries = await readdir(verifiedPath.accessPath);
    await verifyClaimStillOwned(claimed, verifiedPath.accessPath);
    await beforeDestructive?.();
    await markPendingCleanupDestructive(claimed);
    claimed.restorable = false;
    let removedEntries = 0;
    for (const entry of entries) {
      await verifyClaimStillOwned(claimed, verifiedPath.accessPath);
      await rm(join(verifiedPath.accessPath, entry), { recursive: true, force: true });
      removedEntries++;
      await hooks.afterClaimedEntryRemoval?.(worktree, kind, removedEntries);
    }
    await verifyClaimStillOwned(claimed, verifiedPath.accessPath);
  } catch (error) {
    return `exact-identity content cleanup failed; claimed inode was preserved in private quarantine: ${redactQuarantinePath(errorMessage(error), claimed.path)}`;
  } finally {
    await claimed.handle?.close().catch(() => undefined);
  }

  try {
    const rootStats = await lstat(removalPath, { bigint: true });
    if (!rootStats.isDirectory() || !hasFileIdentity(rootStats, claimed.identity)) {
      return "cleaned claimed contents, but the quarantine path now names a replacement and was preserved";
    }
    await rmdir(removalPath);
    if (claimed.pendingRecordPath) await rm(claimed.pendingRecordPath, { force: true });
    if (claimed.removeParentWhenEmpty) await removeEmptyQuarantineRoot(claimed.quarantineRoot);
    return undefined;
  } catch (error) {
    return `claimed contents were removed, but exact-identity quarantine root removal failed and was preserved: ${redactQuarantinePath(errorMessage(error), claimed.path)}`;
  }
}

function sameRuntimeIdentity(left: RuntimeWorktreeIdentity, right: RuntimeWorktreeIdentity): boolean {
  return (
    left.version === right.version &&
    JSON.stringify(left.checkoutProof) === JSON.stringify(right.checkoutProof) &&
    JSON.stringify(left.gitDirProof) === JSON.stringify(right.gitDirProof) &&
    left.repoRoot === right.repoRoot &&
    left.worktreePath === right.worktreePath &&
    hasFileIdentity(left.checkoutIdentity, right.checkoutIdentity) &&
    (left.gitDirIdentity === undefined
      ? right.gitDirIdentity === undefined
      : right.gitDirIdentity !== undefined && hasFileIdentity(left.gitDirIdentity, right.gitDirIdentity)) &&
    left.branch === right.branch &&
    left.branchRef === right.branchRef &&
    left.baseSha === right.baseSha &&
    left.gitCommonRoot === right.gitCommonRoot &&
    left.gitDir === right.gitDir &&
    left.marker === right.marker
  );
}

function sameVerifiedIdentity(left: VerifiedCleanupIdentity, right: VerifiedCleanupIdentity): boolean {
  return (
    sameRuntimeIdentity(left.expected, right.expected) &&
    left.branchOid === right.branchOid &&
    left.nullOid === right.nullOid &&
    left.checkoutPath === right.checkoutPath &&
    hasFileIdentity(right.gitDirIdentity, left.gitDirIdentity) &&
    (left.checkoutIdentity === undefined
      ? right.checkoutIdentity === undefined
      : right.checkoutIdentity !== undefined && hasFileIdentity(right.checkoutIdentity, left.checkoutIdentity))
  );
}

function deterministicBackupRef(identity: RuntimeWorktreeIdentity): string {
  const digest = createHash("sha256")
    .update(JSON.stringify(metadataFromRuntimeIdentity(identity)))
    .digest("hex");
  return `refs/pi-dynamic-workflows/cleanup/${digest}`;
}

interface ClaimedBranch {
  backupRef: string;
  oid: string;
}

async function verifyDirectBranchRef(verified: VerifiedCleanupIdentity): Promise<string | undefined> {
  const { stdout } = await exec("git", [
    "-C",
    verified.expected.repoRoot,
    "for-each-ref",
    "--format=%(objectname)%00%(symref)",
    verified.expected.branchRef,
  ]);
  const record = stdout.trimEnd();
  if (!record) return "temporary branch ref disappeared before cleanup claim";
  const [oid, symref = ""] = record.split("\0");
  if (symref.length > 0) return "temporary branch ref became symbolic before cleanup claim";
  if (oid !== verified.branchOid) return "temporary branch ref changed before cleanup claim";
  return undefined;
}

async function claimBranch(
  worktree: Worktree,
  verified: VerifiedCleanupIdentity,
  hooks: WorktreeCleanupTestHooks,
): Promise<ClaimedBranch | string> {
  let backupRef = "";
  try {
    await hooks.afterBranchRefRead?.(worktree);
    const directRefFailure = await verifyDirectBranchRef(verified);
    if (directRefFailure) throw new Error(directRefFailure);
    backupRef = deterministicBackupRef(verified.expected);
    await exec("git", [
      "-C",
      verified.expected.repoRoot,
      "update-ref",
      "--no-deref",
      backupRef,
      verified.branchOid,
      verified.nullOid,
    ]);
    try {
      await exec("git", [
        "-C",
        verified.expected.repoRoot,
        "update-ref",
        "--no-deref",
        "-d",
        verified.expected.branchRef,
        verified.branchOid,
      ]);
    } catch (error) {
      await exec("git", [
        "-C",
        verified.expected.repoRoot,
        "update-ref",
        "--no-deref",
        "-d",
        backupRef,
        verified.branchOid,
      ]).catch(() => undefined);
      throw error;
    }
    return { backupRef, oid: verified.branchOid };
  } catch (error) {
    const message = backupRef ? errorMessage(error).replaceAll(backupRef, "<cleanup-ref>") : errorMessage(error);
    return `branch ref changed before compare-and-delete cleanup claim: ${message}`;
  }
}

async function restoreClaimedBranch(verified: VerifiedCleanupIdentity, claimedBranch: ClaimedBranch): Promise<string> {
  try {
    await exec("git", [
      "-C",
      verified.expected.repoRoot,
      "update-ref",
      "--no-deref",
      verified.expected.branchRef,
      claimedBranch.oid,
      verified.nullOid,
    ]);
    await exec("git", [
      "-C",
      verified.expected.repoRoot,
      "update-ref",
      "--no-deref",
      "-d",
      claimedBranch.backupRef,
      claimedBranch.oid,
    ]);
    return "the temporary branch was restored after cleanup stopped";
  } catch (error) {
    return `the claimed commit was preserved under an internal recovery ref: ${errorMessage(error).replaceAll(claimedBranch.backupRef, "<cleanup-ref>")}`;
  }
}

async function deleteClaimedBranch(
  worktree: Worktree,
  expected: RuntimeWorktreeIdentity,
  claimedBranch: ClaimedBranch,
  hooks: WorktreeCleanupTestHooks,
): Promise<string | undefined> {
  try {
    await hooks.beforeClaimedBranchDelete?.(worktree);
    await exec("git", [
      "-C",
      expected.repoRoot,
      "update-ref",
      "--no-deref",
      "-d",
      claimedBranch.backupRef,
      claimedBranch.oid,
    ]);
    return undefined;
  } catch (error) {
    return `internal cleanup ref deletion failed; the claimed commit remains preserved under an internal recovery ref and cleanup can be retried: ${errorMessage(error).replaceAll(claimedBranch.backupRef, "<cleanup-ref>")}`;
  }
}

async function claimAndCleanup(
  worktree: Worktree,
  verified: VerifiedCleanupIdentity,
  identity: WorktreeIdentity,
  hooks: WorktreeCleanupTestHooks,
  creationAuthority?: CreationRegistrationAuthority,
  preserveBranch = false,
): Promise<WorktreeCleanupFailure[]> {
  return withRepositoryGitMetadataCleanup(
    verified.expected.gitCommonRoot,
    () => claimAndCleanupLocked(worktree, verified, identity, hooks, creationAuthority, preserveBranch),
    hooks,
  );
}

/** Both source-to-claim renames execute while the cross-process repository lock is held. */
async function claimAndCleanupLocked(
  worktree: Worktree,
  verified: VerifiedCleanupIdentity,
  identity: WorktreeIdentity,
  hooks: WorktreeCleanupTestHooks,
  creationAuthority?: CreationRegistrationAuthority,
  preserveBranch = false,
): Promise<WorktreeCleanupFailure[]> {
  let claimedCheckout: ClaimedDirectory | undefined;
  let claimedRegistration: ClaimedDirectory | undefined;
  let claimedBranch: ClaimedBranch | undefined;

  const stopCleanup = async (stage: WorktreeCleanupStage, message: string): Promise<WorktreeCleanupFailure[]> => {
    const destructiveCleanupStarted =
      claimedRegistration?.restorable === false || claimedCheckout?.restorable === false;
    if (destructiveCleanupStarted) {
      await claimedRegistration?.handle?.close().catch(() => undefined);
      await claimedCheckout?.handle?.close().catch(() => undefined);
      const recovery = claimedBranch
        ? "; exact pending claims and the internal backup ref were preserved for deterministic retry"
        : "; exact pending claims were preserved for deterministic retry";
      return [{ stage, message: boundedDiagnostic(`${message}${recovery}`), identity }];
    }

    const restoration: string[] = [];
    if (claimedBranch) restoration.push(await restoreClaimedBranch(verified, claimedBranch));
    if (claimedRegistration) restoration.push(await restoreClaimedDirectory(claimedRegistration, "registration"));
    if (claimedCheckout) restoration.push(await restoreClaimedDirectory(claimedCheckout, "checkout"));
    const recovery = restoration.length > 0 ? `; ${restoration.join("; ")}` : "";
    return [{ stage, message: boundedDiagnostic(`${message}${recovery}`), identity }];
  };

  let claimParent: string;
  try {
    claimParent = await secureCleanupClaimParent(verified.expected);
  } catch (error) {
    return [identityFailure(identity, `unsafe cleanup claim parent: ${errorMessage(error)}`)];
  }

  if (verified.checkoutIdentity) {
    const checkoutClaim = await claimDirectory(
      worktree,
      "checkout",
      verified.checkoutPath ?? verified.expected.worktreePath,
      claimParent,
      "cleanup-worktree",
      verified.checkoutIdentity,
      hooks,
    );
    if (typeof checkoutClaim === "string") return [identityFailure(identity, checkoutClaim)];
    claimedCheckout = checkoutClaim;
    try {
      await hooks.afterCheckoutClaim?.(worktree);
    } catch (error) {
      return stopCleanup("cleanup_dispatch", `checkout claim verification failed: ${errorMessage(error)}`);
    }
  }

  if (!preserveBranch) {
    const branchClaim = await claimBranch(worktree, verified, hooks);
    if (typeof branchClaim === "string") return stopCleanup("identity_verification", branchClaim);
    claimedBranch = branchClaim;
    try {
      await hooks.afterBranchClaim?.(worktree);
    } catch (error) {
      return stopCleanup("cleanup_dispatch", `branch claim verification failed: ${errorMessage(error)}`);
    }
  }

  const metadataCleanupFailure = await (async (): Promise<WorktreeCleanupFailure[] | undefined> => {
    try {
      await hooks.beforePostClaimRegistrationCheck?.(worktree);
      const registrations = await readRegisteredWorktrees(verified.expected.repoRoot);
      if (
        registrations.some(
          (registration) =>
            registration.path !== verified.expected.worktreePath &&
            registration.branchRef === verified.expected.branchRef,
        )
      ) {
        return stopCleanup(
          "identity_verification",
          "temporary branch was claimed while checked out by another registered worktree",
        );
      }
    } catch (error) {
      return stopCleanup("cleanup_dispatch", `post-claim registered worktree check failed: ${errorMessage(error)}`);
    }

    const registrationClaim = await claimDirectory(
      worktree,
      "registration",
      verified.expected.gitDir,
      claimParent,
      "registration",
      verified.gitDirIdentity,
      hooks,
    );
    if (typeof registrationClaim === "string") {
      return stopCleanup("identity_verification", registrationClaim);
    }
    claimedRegistration = registrationClaim;

    try {
      if (creationAuthority !== "in-memory") {
        const registrationRecord = parseRegistrationRecord(
          (await readClaimedFile(registrationClaim, REGISTRATION_MARKER_FILE, hooks)).trim(),
        );
        const recordedIdentity: RuntimeWorktreeIdentity = {
          version: registrationRecord.version,
          repoRoot: registrationRecord.repoRoot,
          worktreePath: registrationRecord.worktreePath,
          checkoutIdentity: { ...registrationRecord.checkoutIdentity },
          ...(registrationRecord.version === 4
            ? {
                checkoutProof: registrationRecord.checkoutProof,
                gitDirIdentity: { ...registrationRecord.gitDirIdentity },
                ...(registrationRecord.gitDirProof ? { gitDirProof: registrationRecord.gitDirProof } : {}),
              }
            : {}),
          branch: registrationRecord.branch,
          branchRef: registrationRecord.branchRef,
          baseSha: registrationRecord.baseSha,
          gitCommonRoot: registrationRecord.gitCommonRoot,
          gitDir: registrationRecord.gitDir,
          marker: registrationRecord.registrationMarker,
        };
        if (!sameRuntimeIdentity(recordedIdentity, verified.expected)) {
          return stopCleanup("identity_verification", "claimed registration record changed");
        }
      }
      if (claimedCheckout) await hooks.afterWorktreeClaim?.(worktree);
      await hooks.afterRegistrationClaim?.(worktree);

      if (!verified.checkoutIdentity) {
        const registrations = await readRegisteredWorktrees(verified.expected.repoRoot);
        if (
          registrations.some((registration) => registration.path === verified.expected.worktreePath) ||
          (await pathExists(verified.expected.worktreePath))
        ) {
          return stopCleanup(
            "identity_verification",
            "a replacement appeared at the original path after registration claim",
          );
        }
      }
    } catch (error) {
      return stopCleanup(
        "identity_verification",
        `registration claim verification failed; claimed inodes were preserved: ${errorMessage(error)}`,
      );
    }

    // Registration state must be finalized while the complete checkout remains
    // recoverable in quarantine. Checkout contents are the transaction's final
    // destructive data stage, after every registration/branch claim can no
    // longer fail.
    const registrationFailure = await cleanupClaimedContents(
      worktree,
      "registration",
      registrationClaim,
      hooks,
      async () => {
        if (!claimedCheckout) return;
        await markPendingCleanupDestructive(claimedCheckout);
        claimedCheckout.restorable = false;
      },
    );
    if (registrationFailure) return stopCleanup("worktree_remove", registrationFailure);
    claimedRegistration = undefined;

    if (claimedCheckout) {
      const checkoutFailure = await cleanupClaimedContents(worktree, "checkout", claimedCheckout, hooks);
      if (checkoutFailure) return stopCleanup("worktree_remove", checkoutFailure);
      claimedCheckout = undefined;
    }
    return undefined;
  })();
  if (metadataCleanupFailure) return metadataCleanupFailure;

  if (verified.expected.checkoutProof?.kind === "sentinel") {
    try {
      await removeSentinelExclude(
        verified.expected.gitCommonRoot,
        verified.expected.marker,
        verified.expected.checkoutProof,
        hooks,
        true,
      );
    } catch (error) {
      return [
        {
          stage: "worktree_remove",
          message: boundedDiagnostic(`portable sentinel restoration failed: ${errorMessage(error)}`),
          identity,
        },
      ];
    }
  }

  // The private backup remains the only ref guaranteed to preserve the claimed
  // commit until every checkout, registration, and portable sentinel cleanup
  // failure point is past.
  if (!claimedBranch) return [];
  const branchFailure = await deleteClaimedBranch(worktree, verified.expected, claimedBranch, hooks);
  if (branchFailure) {
    let restoration = "";
    if (verified.expected.checkoutProof?.kind === "sentinel") {
      try {
        await restoreSentinelExclude(
          verified.expected.gitCommonRoot,
          verified.expected.marker,
          verified.expected.checkoutProof,
          true,
        );
      } catch (error) {
        restoration = `; portable sentinel restoration rollback failed: ${errorMessage(error)}`;
      }
    }
    return [{ stage: "branch_delete", message: boundedDiagnostic(`${branchFailure}${restoration}`), identity }];
  }
  claimedBranch = undefined;
  return [];
}

interface PendingClaimResumeResult {
  found: boolean;
  failure?: string;
}

async function resumePendingClaim(
  worktree: Worktree,
  expected: RuntimeWorktreeIdentity,
  kind: DirectoryClaimKind,
  quarantineRoot: string,
  hooks: WorktreeCleanupTestHooks,
  layout: CleanupClaimLayout,
): Promise<PendingClaimResumeResult> {
  if (layout === "legacy") {
    const legacyStats = await lstat(quarantineRoot, { bigint: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (!legacyStats || legacyStats.isSymbolicLink() || !legacyStats.isDirectory()) return { found: false };
  }
  const canonicalRoot = await realDirectory(quarantineRoot, false);
  if (layout === "direct" && canonicalRoot !== expected.gitCommonRoot) {
    return { found: true, failure: `${kind} direct pending claim parent is not the trusted Git common directory` };
  }
  const pendingPaths = deterministicQuarantinePaths(canonicalRoot, kind, expected, layout);
  const [directoryExists, recordExists] = await Promise.all([
    pathExists(pendingPaths.directory),
    pathExists(pendingPaths.record),
  ]);
  if (!directoryExists && !recordExists) return { found: false };
  if (!recordExists) {
    return { found: true, failure: `${kind} quarantine exists without its exact pending identity record` };
  }

  let record: PendingCleanupRecordV1;
  try {
    record = parsePendingCleanupRecord(await readRegistrationFile(pendingPaths.record));
  } catch (error) {
    return { found: true, failure: `${kind} pending identity record verification failed: ${errorMessage(error)}` };
  }
  const recordedIdentity: RuntimeWorktreeIdentity = {
    version: record.metadata.version,
    repoRoot: record.metadata.repoRoot,
    worktreePath: record.metadata.worktreePath,
    checkoutIdentity: { ...record.metadata.checkoutIdentity },
    ...(record.metadata.version === 4
      ? {
          checkoutProof: record.metadata.checkoutProof,
          gitDirIdentity: { ...record.metadata.gitDirIdentity },
          ...(record.metadata.gitDirProof ? { gitDirProof: record.metadata.gitDirProof } : {}),
        }
      : {}),
    branch: record.metadata.branch,
    branchRef: record.metadata.branchRef,
    baseSha: record.metadata.baseSha,
    gitCommonRoot: record.metadata.gitCommonRoot,
    gitDir: record.metadata.gitDir,
    marker: record.metadata.registrationMarker,
  };
  if (record.kind !== kind || !sameRuntimeIdentity(recordedIdentity, expected)) {
    return { found: true, failure: `${kind} pending identity record does not match cleanup metadata` };
  }
  if (record.state !== "destructive") {
    return { found: true, failure: `${kind} claim never entered destructive cleanup and was preserved` };
  }

  if (!directoryExists) {
    try {
      await rm(pendingPaths.record);
      if (layout === "legacy") await removeEmptyQuarantineRoot(canonicalRoot);
      return { found: true };
    } catch (error) {
      return {
        found: true,
        failure: `${kind} completed pending identity record removal failed: ${errorMessage(error)}`,
      };
    }
  }

  let pendingStats: Awaited<ReturnType<typeof lstat>>;
  try {
    pendingStats = await lstat(pendingPaths.directory, { bigint: true });
  } catch (error) {
    return { found: true, failure: `${kind} pending quarantine verification failed: ${errorMessage(error)}` };
  }
  if (!pendingStats.isDirectory() || !hasFileIdentity(pendingStats, record.identity)) {
    return { found: true, failure: `${kind} pending quarantine no longer names its recorded exact inode` };
  }
  const claimed: ClaimedDirectory = {
    path: pendingPaths.directory,
    quarantineRoot: canonicalRoot,
    sourcePath: kind === "checkout" ? expected.worktreePath : expected.gitDir,
    pendingRecordPath: pendingPaths.record,
    identity: record.identity,
    restorable: false,
    removeParentWhenEmpty: layout === "legacy",
  };
  const failure = await cleanupClaimedContents(worktree, kind, claimed, hooks);
  return { found: true, ...(failure ? { failure } : {}) };
}

async function resumePendingClaims(
  worktree: Worktree,
  expected: RuntimeWorktreeIdentity,
  identity: WorktreeIdentity,
  hooks: WorktreeCleanupTestHooks,
): Promise<WorktreeCleanupFailure[] | undefined> {
  let claimParent: string;
  try {
    claimParent = await secureCleanupClaimParent(expected);
  } catch (error) {
    return [identityFailure(identity, `unsafe pending cleanup claim parent: ${errorMessage(error)}`)];
  }

  let found = false;
  const locations = [
    ["registration", claimParent, "direct"],
    ["checkout", claimParent, "direct"],
    ["registration", legacyQuarantineRoot(expected, "registration"), "legacy"],
    ["checkout", legacyQuarantineRoot(expected, "checkout"), "legacy"],
  ] as const;
  for (const [kind, root, layout] of locations) {
    const resumed = await resumePendingClaim(worktree, expected, kind, root, hooks, layout);
    found ||= resumed.found;
    if (resumed.failure) {
      return [
        {
          stage: "worktree_remove",
          message: boundedDiagnostic(`pending exact-identity cleanup failed: ${resumed.failure}`),
          identity,
        },
      ];
    }
  }
  return found ? [] : undefined;
}

async function finalizePendingBackup(
  worktree: Worktree,
  expected: RuntimeWorktreeIdentity,
  identity: WorktreeIdentity,
  hooks: WorktreeCleanupTestHooks,
): Promise<WorktreeCleanupFailure[] | undefined> {
  const backupRef = deterministicBackupRef(expected);
  try {
    const { stdout } = await exec("git", [
      "-C",
      expected.repoRoot,
      "for-each-ref",
      "--format=%(objectname)%00%(symref)",
      backupRef,
    ]);
    const record = stdout.trimEnd();
    if (!record) return undefined;
    const [oid, symref = ""] = record.split("\0");
    if (symref.length > 0) return [identityFailure(identity, "pending internal cleanup ref became symbolic")];

    if (!callerMatchesRuntimeIdentity(worktree, expected)) {
      return [identityFailure(identity, "stored worktree identity no longer matches its cleanup metadata")];
    }
    const canonicalRepoRoot = await realpath(expected.repoRoot);
    if (canonicalRepoRoot !== expected.repoRoot) {
      return [identityFailure(identity, "stored repository root is not canonical")];
    }
    try {
      await verifyRuntimeWorktreeContainment(canonicalRepoRoot, expected.gitCommonRoot, expected.worktreePath);
    } catch {
      return [identityFailure(identity, "runtime worktree path is not an exact trusted runtime child")];
    }
    if ((await resolveGitDirectory(canonicalRepoRoot, "--git-common-dir")) !== expected.gitCommonRoot) {
      return [identityFailure(identity, "pending cleanup belongs to a different repository common root")];
    }
    if ((await pathExists(expected.worktreePath)) || (await pathExists(expected.gitDir))) return undefined;
    const registrations = await registeredWorktrees(canonicalRepoRoot, expected.gitCommonRoot);
    if (registrations.some((registration) => registration.path === expected.worktreePath)) {
      return [identityFailure(identity, "pending cleanup path is still registered after registration cleanup")];
    }

    const { stdout: objectFormatOutput } = await exec("git", [
      "-C",
      canonicalRepoRoot,
      "rev-parse",
      "--show-object-format",
    ]);
    const objectFormat = objectFormatOutput.trim();
    const oidWidth = objectFormat === "sha1" ? 40 : objectFormat === "sha256" ? 64 : undefined;
    if (oidWidth === undefined || oid.length !== oidWidth) {
      return [identityFailure(identity, "pending internal cleanup ref has an invalid object ID")];
    }

    if (expected.checkoutProof?.kind === "sentinel") {
      try {
        await removeSentinelExclude(expected.gitCommonRoot, expected.marker, expected.checkoutProof, hooks);
      } catch (error) {
        return [
          {
            stage: "worktree_remove",
            message: boundedDiagnostic(`portable sentinel restoration failed: ${errorMessage(error)}`),
            identity,
          },
        ];
      }
    }
    const failure = await deleteClaimedBranch(worktree, expected, { backupRef, oid }, hooks);
    if (!failure) return [];
    let restoration = "";
    if (expected.checkoutProof?.kind === "sentinel") {
      try {
        await restoreSentinelExclude(expected.gitCommonRoot, expected.marker, expected.checkoutProof);
      } catch (error) {
        restoration = `; portable sentinel restoration rollback failed: ${errorMessage(error)}`;
      }
    }
    return [{ stage: "branch_delete", message: boundedDiagnostic(`${failure}${restoration}`), identity }];
  } catch (error) {
    return [identityFailure(identity, `pending cleanup ref verification failed: ${errorMessage(error)}`)];
  }
}

async function closeCheckoutDirectoryHandle(expected: RuntimeWorktreeIdentity): Promise<void> {
  await closeRuntimeIdentityHandles(expected.marker);
}

/** Internal removal with diagnostics for retained-worktree recovery metadata. */
async function removeWorktreeWithDiagnostics(
  worktree: Worktree,
  hooks: WorktreeCleanupTestHooks = {},
): Promise<WorktreeCleanupFailure[]> {
  if (!worktree.isolated) return [];

  let cleanupWorktree = worktree;
  if (cleanupWorktree.cleanupMetadata?.version === 1) {
    const upgraded = await upgradeVersionOneWorktree(cleanupWorktree);
    if (typeof upgraded === "string") return [identityFailure(cleanupIdentity(cleanupWorktree), upgraded)];
    cleanupWorktree = upgraded;
  } else if (cleanupWorktree.cleanupMetadata?.version === 2) {
    const upgraded = await upgradeVersionTwoWorktree(cleanupWorktree);
    if (typeof upgraded === "string") return [identityFailure(cleanupIdentity(cleanupWorktree), upgraded)];
    cleanupWorktree = upgraded;
  } else if (cleanupWorktree.cleanupMetadata?.version === 3) {
    const upgraded = await upgradeVersionThreeWorktree(cleanupWorktree, hooks);
    if (typeof upgraded === "string") return [identityFailure(cleanupIdentity(cleanupWorktree), upgraded)];
    cleanupWorktree = upgraded;
  } else if (typeof runtimeIdentity(cleanupWorktree) === "string" && isLegacyCleanupShape(cleanupWorktree)) {
    const adopted = await adoptLegacyWorktree(cleanupWorktree);
    if (typeof adopted === "string") return [identityFailure(cleanupIdentity(cleanupWorktree), adopted)];
    cleanupWorktree = adopted;
  }

  const identityKey = runtimeIdentityKey(cleanupWorktree);
  if (identityKey !== undefined && cleanedRuntimeWorktrees.has(identityKey)) return [];
  const identity = cleanupIdentity(cleanupWorktree);
  const expected = runtimeIdentity(cleanupWorktree);
  if (typeof expected === "string") return [identityFailure(identity, expected)];
  if (!callerMatchesRuntimeIdentity(cleanupWorktree, expected)) {
    return [identityFailure(identity, "stored worktree identity no longer matches its cleanup metadata")];
  }

  const pendingClaims = await resumePendingClaims(cleanupWorktree, expected, identity, hooks);
  if (pendingClaims !== undefined) {
    if (pendingClaims.length > 0) return pendingClaims;
    const pendingFinalization = await finalizePendingBackup(cleanupWorktree, expected, identity, hooks);
    if (pendingFinalization === undefined) {
      return [identityFailure(identity, "pending directory cleanup completed without its deterministic backup ref")];
    }
    if (pendingFinalization.length === 0) {
      creationRecoveryAuthorities.delete(cleanupWorktree);
      await closeCheckoutDirectoryHandle(expected);
      if (identityKey !== undefined) rememberCleanedRuntimeWorktree(identityKey);
    }
    return pendingFinalization;
  }

  const creationAuthority = creationRecoveryAuthorities.get(cleanupWorktree);
  const verification = await verifyCleanupIdentity(cleanupWorktree, hooks, creationAuthority);
  if (typeof verification === "string") {
    const pendingFinalization = await finalizePendingBackup(cleanupWorktree, expected, identity, hooks);
    if (pendingFinalization === undefined) return [identityFailure(identity, verification)];
    if (pendingFinalization.length === 0) {
      creationRecoveryAuthorities.delete(cleanupWorktree);
      await closeCheckoutDirectoryHandle(expected);
      if (identityKey !== undefined) rememberCleanedRuntimeWorktree(identityKey);
    }
    return pendingFinalization;
  }

  try {
    await hooks.afterIdentityVerification?.(cleanupWorktree);
  } catch (error) {
    return [identityFailure(identity, `cleanup verification hook failed: ${errorMessage(error)}`)];
  }

  const preclaimVerification = await verifyCleanupIdentity(cleanupWorktree, hooks, creationAuthority);
  if (typeof preclaimVerification === "string" || !sameVerifiedIdentity(verification, preclaimVerification)) {
    return [
      identityFailure(
        identity,
        typeof preclaimVerification === "string"
          ? `worktree identity changed before atomic cleanup claim: ${preclaimVerification}`
          : "worktree identity changed before atomic cleanup claim",
      ),
    ];
  }

  try {
    const creationExpectedOid = hooks.creationRollbackExpectedOid ?? cleanupWorktree.creationRollbackExpectedOid;
    const preserveAdvancedBranch =
      creationExpectedOid !== undefined && preclaimVerification.branchOid !== creationExpectedOid;
    const failures = await claimAndCleanup(
      cleanupWorktree,
      preclaimVerification,
      identity,
      hooks,
      creationAuthority,
      preserveAdvancedBranch,
    );
    if (failures.length === 0) {
      creationRecoveryAuthorities.delete(cleanupWorktree);
      await closeCheckoutDirectoryHandle(expected);
      if (identityKey !== undefined) rememberCleanedRuntimeWorktree(identityKey);
      if (preserveAdvancedBranch) {
        return [
          {
            stage: "branch_delete",
            message: `${CREATION_ADVANCED_BRANCH_PRESERVED}; exact runtime checkout, registration, and proofs were removed`,
            identity,
          },
        ];
      }
    }
    return failures;
  } catch (error) {
    return [
      {
        stage: "cleanup_dispatch",
        message: boundedDiagnostic(`unexpected worktree cleanup failure: ${errorMessage(error)}`),
        identity,
      },
    ];
  }
}

/** Remove a worktree and branch best-effort, preserving the existing no-value API. */
export async function removeWorktree(worktree: Worktree): Promise<undefined> {
  await removeWorktreeWithDiagnostics(worktree);
  return undefined;
}

/** Explicit terminal proof disposal. Call only after all automatic and consumer-owned retries are impossible. */
export async function disposeWorktreeProofs(worktree: Worktree): Promise<void> {
  const marker = worktree.cleanupMetadata?.registrationMarker;
  if (marker && validRegistrationMarker(marker)) await closeRuntimeIdentityHandles(marker);
}

export const DEFAULT_WORKTREE_OPERATIONS: WorktreeOperations = Object.freeze({
  createWorktree,
  removeWorktree: removeWorktreeWithDiagnostics,
  disposeWorktreeProofs,
});

/** @internal Descriptor lifecycle count; deliberately exposes neither handles nor paths. */
export function activeCheckoutProofsForTesting(): {
  descriptorCount: number;
  allocationDescriptorCount: number;
  gitDirDescriptorCount: number;
  excludeDescriptorCount: number;
} {
  return {
    descriptorCount: checkoutDirectoryHandles.size,
    allocationDescriptorCount,
    gitDirDescriptorCount: gitDirectoryHandles.size,
    excludeDescriptorCount: sentinelExcludeHandles.size,
  };
}

/** @internal Narrow deterministic seam for proving the process cache remains bounded. */
export function populateCleanedWorktreeCacheForTesting(identityKeys: readonly string[]): {
  size: number;
  capacity: number;
} {
  for (const identityKey of identityKeys) rememberCleanedRuntimeWorktree(identityKey);
  return { size: cleanedRuntimeWorktrees.size, capacity: MAX_CLEANED_RUNTIME_WORKTREES };
}

/** @internal Narrow deterministic seam for cleanup race regression tests. */
export function createWorktreeOperationsForTesting(hooks: WorktreeCleanupTestHooks): WorktreeOperations {
  return Object.freeze({
    createWorktree,
    removeWorktree: (worktree: Worktree) => removeWorktreeWithDiagnostics(worktree, hooks),
    disposeWorktreeProofs,
  });
}

/**
 * Per-root-run retained worktree registry. Consumers admitted before release are
 * FIFO-serialized. A release request closes admission immediately, waits for all
 * already-admitted consumers, then removes the registered runtime-created tree.
 */
export class RetainedWorktreeRegistry {
  private readonly owner = Symbol("retained-worktree-owner");
  private readonly entries = new Map<WorktreeHandle, RetainedEntry>();
  private admissionClosed = false;

  constructor(
    private readonly operations: WorktreeOperations = DEFAULT_WORKTREE_OPERATIONS,
    private readonly onCleanupFailure?: (failure: WorktreeCleanupFailure) => unknown,
    private readonly validAdmissionToken?: (token: unknown) => boolean,
  ) {}

  closeAdmission(): void {
    this.admissionClosed = true;
  }

  register(worktree: Worktree, admissionToken?: unknown): WorktreeHandle {
    this.assertAdmission(admissionToken);
    if (!worktree.isolated || !worktree.repoRoot || !worktree.branch || !worktree.branchRef || !worktree.baseSha) {
      throw new Error("Cannot retain a worktree without complete runtime-created identity metadata");
    }
    const handle = Object.freeze(Object.create(null)) as WorktreeHandle;
    issuedHandleOwners.set(handle, this.owner);
    this.entries.set(handle, {
      handle,
      canonicalIdentity: createHash("sha256")
        .update(JSON.stringify(["retained-worktree-handle-v1", worktree.branchRef]))
        .digest("hex"),
      worktree,
      tail: Promise.resolve(),
      releaseRequested: false,
      released: false,
    });
    return handle;
  }

  /** Internal opaque identity for canonical nested-call hashing. */
  canonicalIdentity(handle: unknown): string | undefined {
    if ((typeof handle !== "object" && typeof handle !== "function") || handle === null) return undefined;
    const owner = issuedHandleOwners.get(handle);
    if (owner === undefined) return undefined;
    if (owner !== this.owner) throw new Error("Cross-run retained worktree handles are invalid");
    const entry = this.entries.get(handle as WorktreeHandle);
    if (!entry) throw new Error("Unknown retained worktree handle");
    return entry.canonicalIdentity;
  }

  acquire(handle: unknown, admissionToken?: unknown): Promise<RetainedWorktreeLease> {
    this.assertAdmission(admissionToken);
    const entry = this.entryFor(handle);
    if (entry.released) throw new Error("Retained worktree handle has been released");
    if (entry.releaseRequested)
      throw new Error("Retained worktree release is already in progress; new consumers are rejected");

    const previous = entry.tail;
    let finish!: () => void;
    const occupied = new Promise<void>((resolve) => {
      finish = resolve;
    });
    entry.tail = previous.then(() => occupied);
    return previous.then(() => {
      let active = true;
      return {
        worktree: entry.worktree,
        release: () => {
          if (!active) return;
          active = false;
          finish();
        },
      };
    });
  }

  release(handle: unknown, admissionToken?: unknown): Promise<void> {
    this.assertAdmission(admissionToken);
    const entry = this.entryFor(handle);
    return this.releaseEntry(entry);
  }

  async cleanupAll(): Promise<void> {
    this.closeAdmission();
    const entries = [...this.entries.values()];
    const releases = entries.map((entry) => this.releaseEntry(entry));
    await Promise.allSettled(releases);
    await Promise.allSettled(
      entries
        .filter((entry) => !entry.released)
        .map((entry) =>
          Promise.resolve()
            .then(() => (this.operations.disposeWorktreeProofs ?? disposeWorktreeProofs)(entry.worktree))
            .catch((error) => {
              this.reportCleanupFailure({
                stage: "cleanup_dispatch",
                message: boundedDiagnostic(error instanceof Error ? error.message : String(error)),
                identity: cleanupIdentity(entry.worktree),
              });
            }),
        ),
    );
  }

  private assertAdmission(token: unknown): void {
    if (this.validAdmissionToken?.(token)) return;
    if (!this.validAdmissionToken && !this.admissionClosed) return;
    throw new Error("Retained worktree admission is closed; a live pre-close operation token is required");
  }

  private entryFor(handle: unknown): RetainedEntry {
    if ((typeof handle !== "object" && typeof handle !== "function") || handle === null) {
      throw new Error("Malformed or unknown retained worktree handle");
    }
    const owner = issuedHandleOwners.get(handle);
    if (owner === undefined) throw new Error("Malformed or unknown retained worktree handle");
    if (owner !== this.owner) throw new Error("Cross-run retained worktree handles are invalid");
    const entry = this.entries.get(handle as WorktreeHandle);
    if (!entry) throw new Error("Unknown retained worktree handle");
    return entry;
  }

  private releaseEntry(entry: RetainedEntry): Promise<void> {
    if (entry.released) return Promise.resolve();
    if (entry.releasePromise) return entry.releasePromise;
    entry.releaseRequested = true;
    const attempt = entry.tail.then(async () => {
      try {
        const failures = (await this.operations.removeWorktree(entry.worktree)) ?? [];
        for (const failure of failures) this.reportCleanupFailure(failure);
        if (failures.length === 0) entry.released = true;
      } catch (error) {
        this.reportCleanupFailure({
          stage: "cleanup_dispatch",
          message: boundedDiagnostic(error instanceof Error ? error.message : String(error)),
          identity: cleanupIdentity(entry.worktree),
        });
      }
    });
    entry.releasePromise = attempt.finally(() => {
      if (!entry.released) entry.releasePromise = undefined;
    });
    return entry.releasePromise;
  }

  private reportCleanupFailure(failure: WorktreeCleanupFailure): void {
    try {
      const callbackResult = this.onCleanupFailure?.(sanitizeWorktreeCleanupFailure(failure));
      if (callbackResult !== undefined) void Promise.resolve(callbackResult).catch(() => undefined);
    } catch {
      // Cleanup diagnostics must never replace the workflow's result or error.
    }
  }
}

# Run storage protocol

## Files and compatibility

New writes use a versioned `<runId>.json` head and a `<runId>.json.events.jsonl` log. The head stores routing/status fields, compact agent counts/usage, and a committed byte boundary, sequence, generation and SHA-256 chain tip. Scripts, arguments, journals, logs, agent rows and results live in log deltas, not the list index. `<runId>.json.bak` mirrors the last successful head write. Unknown format versions fail closed.

The reader also accepts existing full-JSON records in both external and legacy project-local run directories. Listing legacy history must parse each old record once to derive its summary, but does not retain the full parse or write a migration. A subsequent write migrates that record. New records are not readable by older releases; back up run storage before upgrading if downgrade is required. Use `RunPersistence.load()` to obtain a reconstructed full record; do not treat the new head JSON as a full record.

Conversation delivery exports `{runId, result}` to an immutable, content-hashed `.json.result-<hash>` artifact. It is a presentation artifact, not an input to resume. This preserves a directly readable full-result link without rewriting the full result on every delivery-marker update.

## Commit and recovery

1. Acquire a short per-run writer mutex. Execution/resume/recovery still use the existing long-lived run lease; the mutex serializes log/head changes and delivery metadata.
2. Derive a delta: changed scalar/object fields and changed array cells, including explicit removal and array length. Unchanged completed journal/agent rows are not rewritten. Comparing an arbitrary full state still visits its cells; this protocol bounds growing-history **write volume**, not that comparison's CPU cost.
3. Discard bytes beyond the previously committed boundary, append the next chained JSON entry, and flush the log write.
4. Write and atomically rename the new head, then best-effort refresh its backup. The head rename is the commit point. Release the writer mutex.

After a process crash before step 4, readers ignore the uncommitted tail. The next writer removes it before appending. A missing or unparsable head can fall back to its backup. A truncated or hash-invalid **committed log** fails closed rather than silently replaying an older paid-call prefix. This is a process-crash/atomic-rename protocol, not a promise of power-loss durability on every filesystem or atomic synchronization across cloud-sync clients.

Delivery markers, session ownership and resume counters append small metadata deltas. Orphan recovery appends an agent-settlement operation under the run lease; hydration later applies the same settlement helper used by the live manager. Startup does not read every historical journal merely to settle stale agent status.

Successful deletion removes the head, backup, temporary head, event log and exported result artifacts before releasing run locks. A filesystem deletion failure is reported rather than claiming success; the manager still releases its own lease so the operation can be retried. Retention rechecks terminal status, pending delivery and live lease ownership under the writer mutex. Contended records remain for a later retention pass.

## Listing and memory

Listings cache lightweight views, not hydrated histories. They check directory identity/timestamps after a 300 ms burst cache; atomic head replacement invalidates the directory stamp. A five-second reconciliation catches external in-place edits even when directory timestamps do not change. Changed files are distinguished by inode, size and mtime.

Full-record hydration is lazy and bounded to eight entries with a 16 MiB serialized-weight budget (an accounting limit, not an exact JavaScript heap measurement). Caller-owned loaded records are isolated from the cache. The navigator retains one selected historical snapshot, so visiting many details does not indirectly retain all journals through list-cache keys.

Writer locks never busy-wait. Contention is reported to the caller; existing required checkpoint writes fail closed, while ordinary progress writes retain their existing best-effort behavior. Dead-process mutex owners can be reclaimed; malformed mutexes are left intact because they may belong to an in-progress writer. Unsupported/corrupt storage should be preserved for diagnosis, not manually truncated to make resume proceed.

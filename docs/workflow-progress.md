# RPC workflow progress

In RPC mode the extension writes `pi-dynamic-workflows:progress` custom entries with Pi's `appendEntry()`. Pi immediately sends an `entry_appended` RPC event and retains the entry in the session. These entries do not enter model context and do not trigger assistant turns. The existing minimum Pi version supports this transport.

Hosts read live events and replay custom entries on the current session branch when reconnecting. Pi's `get_entries` also returns abandoned branches, so a host using that command must select the current branch before replaying. The normal conversation result is delivered separately.

## Version 1

The native entry envelope provides `id`, `parentId`, and `timestamp`. Its `data` is a progress update or a deletion:

```ts
type Progress = {
  version: 1;
  runId: string;
  name: string;
  status: "running" | "paused" | "completed" | "failed" | "aborted";
  cwd: string;
  currentPhase?: string;
  agentCount: number;
  runningCount: number;
  doneCount: number;
  errorCount: number;
  tokens?: number;
  estimatedTokens?: boolean;
  cost?: number;
  durationMs?: number;
  resultPreview?: string;
  error?: string;
  agentIds: number[];
  agents: Array<{
    id: number;
    label: string;
    status: "queued" | "running" | "done" | "error" | "skipped";
    phase?: string;
    model?: string;
    tokens?: number;
    estimatedTokens?: boolean;
    promptPreview?: string;
    resultPreview?: string;
    error?: string;
    sessionFile?: string;
  }>;
};

type Deletion = { version: 1; runId: string; deleted: true };
```

Use `runId` for workflow identity and `(runId, agent.id)` for child identity. Labels are not unique. A resumed workflow can also reuse a call identity for separate attempts, so `callId` is not a child-row key.

`agentIds` lists every current child. `agents` contains complete replacements for changed children only; retain unchanged children and remove those absent from `agentIds`. The first update from an observer includes all current children. Apply entries in append order, replacing state by identity. A deletion removes the workflow and its children. Ignore unsupported versions and unrelated custom entry types.

Progress updates are coalesced over one second. Lifecycle transitions flush without waiting for that interval. Before handing work to a replacement session, the outgoing observer synchronously writes deletions for its live running or paused workflows and workflows awaiting result delivery, then detaches. These deletions remove ownership from the outgoing session's display; they do not delete stored workflow data. The new observer publishes full active state after the manager adopts the session. This also applies to reload: deletions and fresh snapshots appear in the same session. Completed history and disk-only paused workflows without pending delivery remain in their original session.

On ordinary shutdown, or when a cross-project replacement cannot retain the runtime, workflows are paused first and queued progress is flushed synchronously before the observer detaches. Replay therefore retains the requested paused state, including the child state available at shutdown; it does not wait for asynchronous child teardown or its final usage accounting. Historical terminal state comes from replay; startup does not hydrate every finished workflow.

Prompts are capped at 500 characters; result previews and errors are capped at 2,000. String results retain that larger preview even when the manager has a shorter summary. Structured child results reuse the manager's existing compact preview. Other structured results, including workflow results, display `Structured result` without traversing their contents; full results remain available in `/workflows`. An absent `sessionFile` means the child session was not persisted. Threaded calls may share a session file, so reading that entire file as one call's transcript would misattribute messages.

## Host presentation

Show the workflow as the parent of its agent rows. Keep its execution state separate from the parent assistant's turn state: returning a background run ID does not mean the workflow completed. Show queued and paused states explicitly, and preserve the estimated-token marker when `estimatedTokens` is true.

The Paseo adapter maps these records to its existing Subagents hierarchy. It uses result previews for child timelines; it does not infer completion from tool return text or import child transcript files.

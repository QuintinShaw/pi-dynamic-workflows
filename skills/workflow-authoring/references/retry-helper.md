# Retry

`retry(thunk, { attempts, until })` takes exactly these 2 arguments; `until` belongs in the options object. It calls `thunk(attempt)` with a zero-based index and defaults to 3 attempts. `until` is synchronous—a Promise or omitted predicate accepts the first result. Exhaustion returns only the last result, so keep an attempt ledger.

Always `await retry()`. A thunk containing `await` must be `async`; await `agent()` before adding its resolved value to the ledger. Runtime retries repeat recoverable execution failures; helper attempts are new semantic calls. Bound both layers and ledger exhaustion.

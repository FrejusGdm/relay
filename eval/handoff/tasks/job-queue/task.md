# Add retries, a dead-letter list and crash-safe persistence to the job queue

`src/queue.ts` is a job queue that lives only in memory and gives up on a job after one failure. Extend it as below. Keep `bun test` passing and add tests for what you change.

## Acceptance criteria

1. A failed job is retried. The `JobQueue` constructor takes an optional options object with `maxAttempts` (default 3), `baseDelayMs` (default 1000), `maxDelayMs` (default 60000), `random` (default `Math.random`) and `now` (default `Date.now`, in milliseconds). After failed attempt `k`, the job may run again after `min(maxDelayMs, baseDelayMs × 2^(k-1)) × (0.5 + random() / 2)` milliseconds, counted from `now()` when the attempt failed. A job is never run before that time.
2. After `maxAttempts` failures the job's status is `dead` and it keeps the last error message; `deadLetters()` lists the dead jobs in the order they were enqueued. The status `failed` no longer exists.
3. `JobQueue.open(path, options)` loads the queue from a JSON file (an empty queue when the file does not exist) and returns it synchronously. That queue saves to the file after every change, including when a job starts running, before its handler is called. A save writes `<path>.tmp` and renames it over `<path>`, so the file is never half written.
4. A job saved as `running` (the process stopped during the job) is `queued` again after `open`, with its attempt count unchanged.
5. `stats()` returns the number of jobs per status as `{ queued, running, done, dead }`, always with all four keys.
6. A job whose type has no handler fails, and is retried like any other failure, with the error `no handler for type <type>`.
7. IDs stay unique after reopening the file.

Every job returned by `get(id)` and `deadLetters()` has these fields:

- `id`, `type` and `payload`, as enqueued. Payloads are plain JSON values.
- `status`: `queued`, `running`, `done` or `dead`.
- `attempts`: how many times the job has started running.
- `runAt`: the earliest `now()` value at which the job may run. For a new job it is `now()` at the time it was enqueued.
- `lastError`: the message of the error thrown by the last failed attempt; absent before the first failure.

`runNext(handlers)` runs, among the queued jobs whose `runAt` has come, the one enqueued first. It resolves to that job once its handler has finished or failed, or to `undefined` when no job is ready.

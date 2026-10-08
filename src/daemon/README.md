# src/daemon

relay's background service, built by the change `add-daemon-api-and-status`. `main.ts` runs
`relay daemon run`: it checks the runtime directory (`paths.ts`), takes the daemon lock and writes
the pid file (`singleton.ts`), starts the API listener from `src/api/`, and shuts down cleanly on a
signal. `log.ts` writes `logs/daemon.log`. `docs/daemon.md` describes the daemon and its commands.

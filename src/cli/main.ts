#!/usr/bin/env -S bun --no-env-file
import { ExitCode } from "./exit-codes";
import { processIo } from "./io";
import { runCli } from "./run";
import type { Logger } from "../core/log";
import { runInterruptActions } from "../core/cleanup";
import { resolveHomedir } from "../core/paths";
import { stopGitProcesses } from "../git/run";

// relay hook ends 500 ms after the process started, whatever happens, so it never holds up an agent
// (add-daemon-api-and-status, design decision 18, step 1).
if (process.argv[2] === "hook") setTimeout(() => process.exit(0), Math.max(0, 500 - performance.now()));

let log: Logger | undefined;
// relay first removes what the interrupted command registered with onInterrupt. git runs in its own
// process group, so Control-C does not reach it; relay stops it before exiting.
// Stopping git can let the command finish first, so the normal exit keeps the interrupt's code.
let interruptedCode: number | undefined;
const stop = async (signal: "SIGINT" | "SIGTERM" | "SIGHUP", code: number) => {
  interruptedCode = code;
  log?.warn("command interrupted", { signal });
  runInterruptActions();
  await stopGitProcesses();
  process.exit(code);
};
process.on("SIGINT", () => stop("SIGINT", ExitCode.Interrupted));
process.on("SIGTERM", () => stop("SIGTERM", ExitCode.Terminated));
// A closed terminal sends SIGHUP. Without a handler relay would end without its cleanup, and an
// agent it started in its own process group would keep running.
process.on("SIGHUP", () => stop("SIGHUP", ExitCode.Terminated));

const code = await runCli({
  argv: process.argv.slice(2),
  cwd: process.cwd(),
  env: process.env,
  homedir: resolveHomedir(process.env),
  uid: process.getuid!(),
  io: processIo(),
  onLogOpened: (opened) => (log = opened),
});
await stopGitProcesses();
process.exit(interruptedCode ?? code);

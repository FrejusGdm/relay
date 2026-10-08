// Stands in for relay's entry point (src/cli/main.ts): it runs one git command through the runner
// and, on SIGINT, stops the git processes before exiting, as main.ts does.
// Usage: bun run-git.ts <repository> <temporary index>
import { git, stopGitProcesses } from "../../../src/git/run";

const [repo, indexFile] = process.argv.slice(2) as [string, string];
let interruptedCode: number | undefined;
process.on("SIGINT", async () => {
  interruptedCode = 130;
  await stopGitProcesses();
  process.exit(130);
});
await git(repo, ["add", "-A"], { indexFile });
await stopGitProcesses();
process.exit(interruptedCode ?? 0);

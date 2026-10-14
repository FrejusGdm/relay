// What a waiting relay run prints (add-resume-at-reset, design decision 6): it follows the job
// from the waiting event it wrote, so an end the daemon recorded before relay run began to follow
// is still found.
import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appendEvent } from "../../src/job/events";
import { followWait } from "../../src/resume/follow";
import type { WaitRecord } from "../../src/resume/wait";
import { tempRelayHome } from "../helpers/relay-home";

test("an end recorded before relay run follows the job is still found", async () => {
  const relayHome = tempRelayHome();
  const root = join(relayHome, "project");
  mkdirSync(join(root, ".relay"), { recursive: true });
  writeFileSync(join(root, ".relay", "events.jsonl"), "");
  const job = { id: "aaaaaaaa", worktreeRoot: root, relayHome };
  const waiting = await appendEvent(job, "resume_at_reset_waiting", { target: "claude:work", reset_at: null, next_check_at: null });
  await appendEvent(job, "resume_at_reset_resumed", { worker_id: "22222222", target: "claude:work", provider_session_id: "7c1e9a52-0000", resume: 1 });
  await appendEvent(job, "resume_at_reset_ended", { outcome: "finished", reason: "completed", exit_code: 0, resumes: 1, resumes_in_a_row: 0 });
  let out = "";
  let err = "";
  const ctx = {
    relayHome, homedir: relayHome, env: {}, config: {} as never,
    io: { out: (text: string) => { out += text; }, err: (text: string) => { err += text; }, stdinIsTTY: false, stdoutIsTTY: false, isTerminal: false, readStdin: async () => Buffer.alloc(0), readLine: async () => null },
  };
  const wait = { account: "claude:work", provider: "claude" } as WaitRecord;
  const code = await followWait(ctx, job, wait, false, (line) => { out += `${line}\n`; }, waiting.id);
  expect({ code, err }).toEqual({ code: 0, err: "" });
  expect(out).toBe("Continuing session 7c1e9a52 on claude:work (resume 1).\nThe task ended normally after 1 resume.\n");
});

// Task 7.1: POST /v1/jobs/{job}/checkpoint saves a checkpoint through the checkpoint engine, one
// operation per job at a time, with the engine's refusals as API errors, and a daemon that receives
// SIGTERM lets a running checkpoint finish and answer. The person's branch, index, stash and files
// stay as they were.
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import type { Subprocess } from "bun";
import { FAKE_SCANNER, jobId, personState, relayRefs, setUpJob } from "../helpers/job";
import { removeTempRelayHomes, spawnDaemon, stopDaemon, testSocket, waitForDaemon } from "../helpers/relay-home";
import type { ScratchRepo } from "../helpers/scratch-repo";

setDefaultTimeout(60_000);

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  removeTempRelayHomes();
});

// A scratch job and a daemon that saves checkpoints with the fake secret scanner. `env` goes to the
// daemon, for example FAKE_GITLEAKS_SLEEP to make each checkpoint slow.
async function project(env: Record<string, string> = {}): Promise<{ scratch: ScratchRepo; job: string; daemon: Subprocess }> {
  const scratch = await setUpJob("full", undefined, FAKE_SCANNER);
  cleanups.push(() => scratch.cleanup());
  const daemon = spawnDaemon(scratch.relayHome, { ...FAKE_SCANNER, ...env });
  cleanups.push(() => stopDaemon(daemon));
  await waitForDaemon(scratch.relayHome);
  return { scratch, job: jobId(scratch), daemon };
}

function post(scratch: ScratchRepo, path: string, body?: unknown): Promise<Response> {
  return fetch(`http://relay${path}`, {
    unix: testSocket(scratch.relayHome),
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? "" : JSON.stringify(body),
  });
}

async function answer(response: Response | Promise<Response>): Promise<{ status: number; body: Record<string, any> }> {
  const done = await response;
  return { status: done.status, body: (await done.json()) as Record<string, any> };
}

// The event types of a stream, as they arrive.
function eventTypes(response: Response): { types: string[]; stop(): void } {
  const types: string[] = [];
  const reader = response.body!.getReader();
  let text = "";
  void (async () => {
    for (;;) {
      const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true }));
      if (done) return;
      text += new TextDecoder().decode(value);
      let end: number;
      while ((end = text.indexOf("\n\n")) !== -1) {
        const event = /^event: (.+)$/m.exec(text.slice(0, end))?.[1];
        if (event !== undefined) types.push(event);
        text = text.slice(end + 2);
      }
    }
  })();
  return { types, stop: () => void reader.cancel().catch(() => {}) };
}

async function until(check: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`not within ${ms} ms`);
    await Bun.sleep(25);
  }
}

test("a checkpoint with a message returns 201, creates the ref, reaches the event stream and leaves the person's work alone", async () => {
  const { scratch, job } = await project();
  scratch.write("src/refactor.ts", "export const before = true;\n");
  const before = personState(scratch.repo);
  const stream = eventTypes(await fetch(`http://relay/v1/events?job=${job}`, { unix: testSocket(scratch.relayHome) }));
  cleanups.push(() => stream.stop());

  const { status, body } = await answer(post(scratch, `/v1/jobs/${job}/checkpoint`, { message: "before refactor" }));
  expect(status).toBe(201);
  expect(body.checkpoint).toMatchObject({ number: 2, ref: `refs/relay/jobs/${job}/checkpoints/2`, kind: "manual", message: "before refactor" });
  expect(Object.keys(body.checkpoint).sort()).toEqual(["commit", "created_at", "kind", "message", "number", "ref"]);
  expect(scratch.git("rev-parse", `refs/relay/jobs/${job}/checkpoints/2`).trim()).toBe(body.checkpoint.commit);
  await until(() => stream.types.includes("checkpoint"));
  // The answer came after the index caught up, so the job already shows the checkpoint.
  const shown = await answer(fetch(`http://relay/v1/jobs/${job}`, { unix: testSocket(scratch.relayHome) }));
  expect(shown.body.job.last_checkpoint.number).toBe(2);
  expect(personState(scratch.repo)).toEqual(before);

  // Nothing changed since: the latest checkpoint, with 200.
  const again = await answer(post(scratch, `/v1/jobs/${job}/checkpoint`));
  expect(again.status).toBe(200);
  expect(again.body.checkpoint.number).toBe(2);
});

test("a second checkpoint or switch while a checkpoint runs gets 409 operation_in_progress", async () => {
  const { scratch, job } = await project({ FAKE_GITLEAKS_SLEEP: "2000" });
  scratch.write("src/slow.ts", "export const slow = true;\n");
  const first = post(scratch, `/v1/jobs/${job}/checkpoint`, { message: "slow" });
  await Bun.sleep(500);
  const busy = { error: { code: "operation_in_progress", message: `Job ${job} is already being checkpointed.` } };
  expect(await answer(post(scratch, `/v1/jobs/${job}/checkpoint`))).toEqual({ status: 409, body: busy });
  expect(await answer(post(scratch, `/v1/jobs/${job}/switch`, { target: "codex:personal" }))).toEqual({ status: 409, body: busy });
  expect((await answer(first)).status).toBe(201);
});

test("a planted secret returns 422 secret_found and creates no ref", async () => {
  const { scratch, job } = await project();
  const refs = relayRefs(scratch);
  scratch.write("src/config.ts", "export const key = \"FAKE-SECRET\";\n");
  const { status, body } = await answer(post(scratch, `/v1/jobs/${job}/checkpoint`));
  expect(status).toBe(422);
  expect(body.error.code).toBe("secret_found");
  expect(body.error.message).toStartWith("Stopped: possible secret in src/config.ts line 1");
  expect(body.error.message).not.toContain("FAKE-SECRET\"");
  expect(relayRefs(scratch)).toEqual(refs);
});

test("an untracked file with a secret-like name returns 422 untracked_secret_file", async () => {
  const { scratch, job } = await project();
  const refs = relayRefs(scratch);
  scratch.write("credentials.json", "{}\n");
  const { status, body } = await answer(post(scratch, `/v1/jobs/${job}/checkpoint`));
  expect(status).toBe(422);
  expect(body.error.code).toBe("untracked_secret_file");
  expect(relayRefs(scratch)).toEqual(refs);
});

test("a changed .git/config returns 409 git_changes_not_accepted and creates no ref", async () => {
  const { scratch, job } = await project();
  const refs = relayRefs(scratch);
  scratch.write("src/work.ts", "export const work = 1;\n");
  scratch.git("config", "core.editor", "vi");
  const { status, body } = await answer(post(scratch, `/v1/jobs/${job}/checkpoint`));
  expect(status).toBe(409);
  expect(body.error.code).toBe("git_changes_not_accepted");
  expect(relayRefs(scratch)).toEqual(refs);
});

test("requests carry no command and no path: unknown fields, bad messages and unknown jobs are refused", async () => {
  const { scratch, job } = await project();
  expect(await answer(post(scratch, `/v1/jobs/${job}/checkpoint`, { message: "x", cwd: "/tmp" }))).toEqual({
    status: 400, body: { error: { code: "bad_request", message: 'relay does not accept the field "cwd" here. Send only message.' } },
  });
  expect((await answer(post(scratch, `/v1/jobs/${job}/checkpoint`, { message: "x".repeat(501) }))).body.error.code).toBe("bad_request");
  expect(await answer(post(scratch, "/v1/jobs/ffffffff/checkpoint"))).toEqual({
    status: 404, body: { error: { code: "job_not_found", message: "No job with id ffffffff." } },
  });
});

test("SIGTERM during a checkpoint lets it finish and answer, and refuses new connections", async () => {
  const { scratch, job, daemon } = await project({ FAKE_GITLEAKS_SLEEP: "2000" });
  scratch.write("src/last.ts", "export const last = true;\n");
  const running = post(scratch, `/v1/jobs/${job}/checkpoint`, { message: "last one" });
  await Bun.sleep(500);
  daemon.kill("SIGTERM");
  await Bun.sleep(200);
  const refused = await fetch("http://relay/v1/version", { unix: testSocket(scratch.relayHome) }).then(() => false, () => true);
  expect(refused).toBe(true);
  const { status, body } = await answer(running);
  expect(status).toBe(201);
  expect(scratch.git("rev-parse", `refs/relay/jobs/${job}/checkpoints/2`).trim()).toBe(body.checkpoint.commit);
  expect(await daemon.exited).toBe(0);
});

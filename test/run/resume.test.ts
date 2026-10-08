// relay run --resume <session ID> and --resume last (task 9.7).
import { expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { writeWorkerRecord } from "../../src/run/worker-record";
import { relayRun, runFixture, steps, workers } from "./helpers";

const done = steps({ say: "Done." });

test("--resume last resumes the job's last Codex thread on the same account", async () => {
  const fixture = await runFixture('[accounts."codex:personal"]\n');
  try {
    expect((await relayRun(fixture, ["codex:personal", "--headless", "--prompt", "Start."], done)).code).toBe(0);
    const thread = workers(fixture)[0]!.provider_session_id!;
    expect(thread).toEqual(expect.any(String));
    const record = join(fixture.scratch.root, "record.json");
    const result = await relayRun(fixture, ["codex:personal", "--resume", "last", "--headless", "--prompt", "Continue."], done, { RELAY_FAKE_RECORD: record });
    expect(result.code).toBe(0);
    const messages = (JSON.parse(readFileSync(record, "utf8")).input as string[]).map((line) => JSON.parse(line));
    expect(messages.find((message) => message.method === "thread/resume")?.params.threadId).toBe(thread);
    expect(messages.some((message) => message.method === "thread/start")).toBe(false);
    expect(workers(fixture)[0]).toMatchObject({ resumed_from: thread, provider_session_id: thread });
  } finally {
    fixture.cleanup();
  }
});

test("--resume last with no earlier session on the account exits 2", async () => {
  const fixture = await runFixture();
  try {
    expect(await relayRun(fixture, ["claude:work", "--resume", "last", "--headless", "--prompt", "Go."], done)).toMatchObject({
      code: 2, stderr: "This job has no earlier Claude Code session on claude:work to resume.\n",
    });
    expect(workers(fixture)).toEqual([]);
  } finally {
    fixture.cleanup();
  }
});

test("a session started on another account is refused with exit 25; an unknown one is passed on", async () => {
  const fixture = await runFixture();
  try {
    writeFileSync(join(fixture.relayHome, "config.toml"),
      `[accounts."claude:work"]\n\n[accounts."claude:home"]\n\n[[projects]]\npath = ${JSON.stringify(fixture.scratch.repo)}\nallow = ["claude:work", "claude:home"]\n`,
      { mode: 0o600 });
    expect((await relayRun(fixture, ["claude:work", "--headless", "--prompt", "Start."], done)).code).toBe(0);
    const session = workers(fixture)[0]!.provider_session_id!;
    expect(await relayRun(fixture, ["claude:home", "--resume", session, "--headless", "--prompt", "Go."], done)).toMatchObject({
      code: 25, stderr: `Session ${session} was started on claude:work. relay resumes a session only on the account that started it.\n`,
    });

    // A session that a worker of another job started on claude:work is refused too.
    const elsewhere = "5b0f2a4e-1c2d-4e3f-8a9b-0c1d2e3f4a5b";
    writeWorkerRecord(fixture.relayHome, { ...workers(fixture)[0]!, job_id: "0a1b2c3d", worker_id: "0f0f0f0f", provider_session_id: elsewhere });
    expect((await relayRun(fixture, ["claude:home", "--resume", elsewhere, "--headless", "--prompt", "Go."], done)).code).toBe(25);

    const unknown = "0199a3c2-7d4e-4b10-9c1a-2f5e8d6b4a31";
    const record = join(fixture.scratch.root, "record.json");
    const result = await relayRun(fixture, ["claude:home", "--resume", unknown, "--headless", "--prompt", "Go."], done, { RELAY_FAKE_RECORD: record });
    expect(result.code).toBe(0);
    const argv = JSON.parse(readFileSync(record, "utf8")).argv as string[];
    expect(argv[argv.indexOf("--resume") + 1]).toBe(unknown);
    expect(workers(fixture)[0]).toMatchObject({ account: "claude:home", resumed_from: unknown, provider_session_id: unknown });
  } finally {
    fixture.cleanup();
  }
});

test("--resume last skips a session that the program never confirmed", async () => {
  const fixture = await runFixture();
  try {
    expect((await relayRun(fixture, ["claude:work", "--headless", "--prompt", "Start."], done)).code).toBe(0);
    const confirmed = workers(fixture)[0]!;
    // A newer worker whose session relay chose, but whose program never started a session.
    writeWorkerRecord(fixture.relayHome, {
      ...confirmed, worker_id: "0f0f0f0f", provider_session_id: "5b0f2a4e-1c2d-4e3f-8a9b-0c1d2e3f4a5b",
      started_at: new Date(Date.parse(confirmed.started_at) + 1).toISOString(),
    });
    const result = await relayRun(fixture, ["claude:work", "--resume", "last", "--headless", "--prompt", "Go."], done);
    expect(result.code).toBe(0);
    expect(workers(fixture).find((entry) => entry.resumed_from !== null)).toMatchObject({ resumed_from: confirmed.provider_session_id });
  } finally {
    fixture.cleanup();
  }
});

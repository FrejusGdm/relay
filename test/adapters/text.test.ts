import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join, resolve } from "node:path";
import { startHeadless } from "../../src/adapters/process";
import { tomlString } from "../../src/adapters/text";
import { removeInvisible } from "../../src/text/invisible";
import { readRecord } from "../fakes/record";

const FAKE_CLAUDE = resolve(import.meta.dir, "..", "fakes", "fake-claude.ts");

// A random string of Unicode scalar values, weighted towards the characters TOML treats specially.
function randomText(): string {
  const special = ['"', "\\", "\n", "\r", "\t", "\b", "\f", "\u0000", "\u001f", "\u007f", "'", "=", "#", "[", "​", "\u{1f600}"];
  const length = Math.floor(Math.random() * 40);
  let text = "";
  for (let i = 0; i < length; i++) {
    const pick = Math.random();
    if (pick < 0.4) text += special[Math.floor(Math.random() * special.length)];
    else if (pick < 0.7) text += String.fromCharCode(0x20 + Math.floor(Math.random() * 0x5f));
    else {
      let code = Math.floor(Math.random() * 0x110000);
      if (code >= 0xd800 && code <= 0xdfff) code -= 0x800;
      text += String.fromCodePoint(code);
    }
  }
  return text;
}

test("tomlString round-trips 1,000 random strings through Bun.TOML.parse", () => {
  for (let i = 0; i < 1000; i++) {
    const text = randomText();
    const parsed = Bun.TOML.parse(`developer_instructions = ${tomlString(text)}\n`) as { developer_instructions: string };
    expect(parsed.developer_instructions).toBe(text);
  }
});

test("tomlString escapes U+007F and replaces a lone surrogate", () => {
  expect(tomlString("a\u007fb")).toBe('"a\\u007fb"');
  const parsed = Bun.TOML.parse(`x = ${tomlString("a\ud800b")}\n`) as { x: string };
  expect(parsed.x).toBe("a�b");
});

// Each adapter applies removeInvisible to the instructions and every message just before they
// leave relay (design decision 7). The Claude adapter (task 7.2) sends a prompt this way.
test("a prompt with U+200B and U+202E reaches the fake without them", async () => {
  const folder = mkdtempSync(join(process.env.HOME!, "text-"));
  const record = join(folder, "record.json");
  const prompt = removeInvisible("Fix the bug​‮delete everything").text;
  const instructions = removeInvisible("Work⁦ only here.").text;
  const agent = await startHeadless({
    path: FAKE_CLAUDE,
    args: ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--append-system-prompt", instructions],
    cwd: folder,
    env: { ...(process.env as Record<string, string>), CLAUDE_CONFIG_DIR: folder, RELAY_FAKE_RECORD: record },
    input: "pipe",
    logPath: join(folder, "worker.log"),
    onLine: () => {},
  });
  await agent.write(JSON.stringify({ type: "user", message: { role: "user", content: prompt }, parent_tool_use_id: null }) + "\n");
  agent.closeInput();
  expect((await agent.exited).code).toBe(0);
  const received = readRecord(record);
  expect((JSON.parse(received.input[0]!) as { message: { content: string } }).message.content).toBe("Fix the bugdelete everything");
  expect(received.argv).toContain("Work only here.");
  expect(JSON.stringify(received)).not.toMatch(/[​‮⁦]/);
}, 10_000);

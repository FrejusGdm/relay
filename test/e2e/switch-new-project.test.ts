// The first switch on a new project, from a second terminal: relay run in terminal A registers the
// project with its own account, and relay switch --yes in terminal B adds the next account. Only
// relay switch, which asked the question, records the answer in config.toml; the relay run that
// performs the switch only reads it.
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { jobEvents, until } from "../run/helpers";
import { relayProcess, relayTerminal, Scenarios } from "../handoff/switch-helpers";
import { e2eFixture, type E2eFixture } from "./helpers";

setDefaultTimeout(120_000);

let fixture: E2eFixture;
afterEach(() => fixture?.cleanup());

const config = () => readFileSync(join(fixture.relayHome, "config.toml"), "utf8");

test("relay switch --yes in a second terminal adds the account once, and relay run completes the switch", async () => {
  fixture = await e2eFixture({ allow: null });
  fixture.scenarios.set({ claude: Scenarios.fixture("claude-edits-two-files.json"), codex: Scenarios.fixture("codex-starts.json") });
  const a = relayTerminal(fixture, ["run", "claude:personal"]);
  try {
    await until(() => a.output().includes("The callback is done."), 30_000);
    expect(config().match(/^\[\[projects\]\]$/gm)).toHaveLength(1);
    expect(config()).toContain('allow = ["claude:personal"]\n');
    fixture.scenarios.set({ claude: Scenarios.fixture("claude-answers-notes.json"), codex: Scenarios.fixture("codex-starts.json") });

    const b = relayProcess(fixture, ["switch", "codex:personal", "--yes"]);
    const code = await b.exited;
    expect({ code, stderr: b.stderr() }).toEqual({ code: 0, stderr: "" });
    await until(() => a.output().includes("Reading .relay/checkpoint.md"), 30_000);
    expect(a.output()).toContain("Continuing on Codex.");

    expect(config().match(/^\[\[projects\]\]$/gm)).toHaveLength(1);
    expect(config().match(/^allow = .*$/gm)).toEqual(['allow = ["claude:personal", "codex:personal"]']);
    expect(jobEvents(fixture).filter((event) => event.type === "provider_allowed").map((event) => event.data))
      .toEqual([{ account: "codex:personal", company: "OpenAI", how: "flag" }]);
  } finally {
    a.child.kill("SIGTERM");
    await a.child.exited;
  }
});

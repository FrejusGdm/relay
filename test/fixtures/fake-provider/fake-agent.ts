// A scripted stand-in for an agent program. Run it as
// `bun test/fixtures/fake-provider/fake-agent.ts <scenario.json>`; README.md describes the format.
import { readFileSync, writeFileSync, writeSync } from "node:fs";

type Step = { stdout: string } | { stderr: string } | { sleep_ms: number } | { exit: number };

const scenarioFile = process.argv[2];
if (scenarioFile === undefined) {
  writeSync(2, "Usage: fake-agent.ts <scenario.json>\n");
  process.exit(2);
}

const recordFile = process.env.FAKE_AGENT_RECORD;
if (recordFile) {
  const record = {
    argv: process.argv.slice(2),
    cwd: process.cwd(),
    env_names: Object.keys(process.env).sort(),
  };
  writeFileSync(recordFile, JSON.stringify(record, null, 2) + "\n");
}

const scenario = JSON.parse(readFileSync(scenarioFile, "utf8")) as { steps: Step[] };
for (const step of scenario.steps) {
  if ("stdout" in step) writeSync(1, step.stdout + "\n");
  else if ("stderr" in step) writeSync(2, step.stderr + "\n");
  else if ("sleep_ms" in step) await new Promise((resolve) => setTimeout(resolve, step.sleep_ms));
  else if ("exit" in step) process.exit(step.exit);
  else {
    writeSync(2, "fake agent: unknown step\n");
    process.exit(2);
  }
}
process.exit(0);

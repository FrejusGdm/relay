#!/usr/bin/env bun
// A stand-in for gitleaks in unit tests, selected with RELAY_GITLEAKS=<this file>.
// - `version` prints FAKE_GITLEAKS_VERSION, or 8.30.1.
// - `stdin` reports one finding for each input line that contains FAKE-SECRET, with the rule
//   written after it as FAKE-SECRET:<rule> (fake-rule otherwise), and exits with the value of
//   --exit-code when it found something. The report's Secret, Match and Line fields hold the whole
//   line, so tests can check that relay never shows them.
// - FAKE_GITLEAKS_SLEEP makes it wait that many milliseconds after reading its input.
// - FAKE_GITLEAKS_EXIT makes it print FAKE_GITLEAKS_STDERR and exit with that code instead, after
//   writing FAKE_GITLEAKS_REPORT as the report when that is set.
// - FAKE_GITLEAKS_RECORD names a JSON file where it writes its arguments, its input, the content of
//   the --config and --gitleaks-ignore-path files, whether GITLEAKS_CONFIG or
//   GITLEAKS_CONFIG_TOML reached it, and the files of the report's folder with their modes.
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const args = process.argv.slice(2);
const env = process.env;
const option = (name: string) => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};

if (args[0] === "version") {
  console.log(env.FAKE_GITLEAKS_VERSION ?? "8.30.1");
  process.exit(0);
}

const input = await new Response(Bun.stdin.stream()).text();
if (env.FAKE_GITLEAKS_SLEEP) await Bun.sleep(Number(env.FAKE_GITLEAKS_SLEEP));
const report = option("--report-path")!;

if (env.FAKE_GITLEAKS_RECORD) {
  const folder = dirname(report);
  writeFileSync(
    env.FAKE_GITLEAKS_RECORD,
    JSON.stringify({
      args,
      input,
      config: readFileSync(option("--config")!, "utf8"),
      ignore: readFileSync(option("--gitleaks-ignore-path")!, "utf8"),
      configVariables: ["GITLEAKS_CONFIG", "GITLEAKS_CONFIG_TOML"].filter((name) => env[name] !== undefined),
      files: readdirSync(folder).sort().map((name) => ({ name, mode: statSync(join(folder, name)).mode & 0o777 })),
    }),
  );
}

if (env.FAKE_GITLEAKS_EXIT) {
  if (env.FAKE_GITLEAKS_REPORT !== undefined) writeFileSync(report, env.FAKE_GITLEAKS_REPORT);
  process.stderr.write(env.FAKE_GITLEAKS_STDERR ?? "");
  process.exit(Number(env.FAKE_GITLEAKS_EXIT));
}

const findings = input.split("\n").flatMap((line, index) => {
  const match = /FAKE-SECRET(?::([\w-]+))?/.exec(line);
  if (match === null) return [];
  return [{ RuleID: match[1] ?? "fake-rule", StartLine: index + 1, EndLine: index + 1, Secret: line, Match: line, Line: line, Fingerprint: `:x:${index + 1}` }];
});
writeFileSync(report, JSON.stringify(findings));
process.exit(findings.length > 0 ? Number(option("--exit-code")) : 0);

import { expect, test } from "bun:test";
import { redact } from "../../src/secrets/redact";

// Token-shaped values are built at run time, so the repository holds none.
const letters = (count: number) => "aB3".repeat(Math.ceil(count / 3)).slice(0, count);
const UPPER = (count: number) => "A7Z".repeat(Math.ceil(count / 3)).slice(0, count);

const CASES: [string, string, string][] = [
  ["an Anthropic key", `key ${"sk-ant-"}${letters(24)} end`, "key [redacted] end"],
  ["an OpenAI key", `key ${"sk-"}proj-${letters(30)} end`, "key [redacted] end"],
  ["a GitHub token", `git push https://x:${"ghp_"}${letters(36)}@github.com/o/r`, "git push https://x:[redacted]@github.com/o/r"],
  ["a GitHub server token", `${"ghs_"}${letters(36)}`, "[redacted]"],
  ["a fine-grained GitHub token", `${"github_pat_"}${letters(40)}`, "[redacted]"],
  ["a Slack token", `${"xoxb-"}${letters(30)}`, "[redacted]"],
  ["an AWS access key", `aws configure set ${"AKIA"}${UPPER(16)}`, "aws configure set [redacted]"],
  ["a JSON web token", `token ${"eyJ"}${letters(20)}.${letters(30)}.${letters(30)} end`, "token [redacted] end"],
  ["a bearer value", `curl -H "authorization: bearer ${letters(12)}" x`, 'curl -H "authorization: bearer [redacted]" x'],
  ["a TOKEN variable", `MY_TOKEN=${letters(8)} make deploy`, "MY_TOKEN=[redacted] make deploy"],
  ["a SECRET variable", `client_secret='${letters(8)} two' run`, "client_secret=[redacted] run"],
  ["a PASSWORD variable", `DB_PASSWORD="${letters(8)}" psql`, "DB_PASSWORD=[redacted] psql"],
  ["an API_KEY variable", `export SERVICE_API_KEY=${letters(8)}`, "export SERVICE_API_KEY=[redacted]"],
  ["an APIKEY variable", `apikey=${letters(8)}`, "apikey=[redacted]"],
  ["--password", `mysql --password ${letters(8)} db`, "mysql --password [redacted] db"],
  ["--token", `cli --token=${letters(8)} go`, "cli --token=[redacted] go"],
  ["--api-key", `cli --api-key "${letters(8)}" go`, "cli --api-key [redacted] go"],
  ["a value with an escaped quote", `DB_PASSWORD="${letters(4)}\\"${letters(4)}" psql`, "DB_PASSWORD=[redacted] psql"],
  ["a value in quoted and unquoted pieces", `API_KEY="${letters(4)}"'${letters(4)}'${letters(4)} run`, "API_KEY=[redacted] run"],
  ["a value before a command separator", `MY_TOKEN=${letters(8)}&&bun test`, "MY_TOKEN=[redacted]&&bun test"],
  ["a value whose quote is never closed", `MY_SECRET="${letters(8)} rest`, "MY_SECRET=[redacted]"],
];

for (const [name, input, expected] of CASES) {
  test(`redacts ${name}`, () => {
    expect(redact(input)).toBe(expected);
  });
}

test("the Authorization: Bearer command of the agent-runs spec keeps no part of the token", () => {
  const token = `${"ghp_"}${letters(36)}`;
  const command = `curl -H "Authorization: Bearer ${token}" https://api.github.com`;
  const result = redact(command);
  expect(result).toBe('curl -H "Authorization: Bearer [redacted]" https://api.github.com');
  expect(result).not.toContain(token.slice(4));
});

test("ordinary commands are left alone", () => {
  for (const command of ["bun test", "npm run build -- --watch", "git commit -m 'Fix the token parser'", "ls ~/.ssh"]) {
    expect(redact(command)).toBe(command);
  }
});

test("a 1 MB command is redacted in well under 100 ms and cut to 500 characters", () => {
  for (const line of [
    `MY_TOKEN${"TOKEN".repeat(200_000)} run`,
    `${"x".repeat(1024 * 1024)} API_KEY=${letters(8)}`,
    `Bearer ${" ".repeat(1024 * 1024)}`,
    `${"eyJ".repeat(350_000)}`,
  ]) {
    const start = performance.now();
    const result = redact(line);
    expect(performance.now() - start).toBeLessThan(100);
    expect(result.length).toBeLessThanOrEqual(500);
  }
});

test("the result is cut to the length the caller gives, after the redaction", () => {
  const token = `${"ghp_"}${letters(36)}`;
  expect(redact(`echo ${token} ${"y".repeat(1000)}`)).toBe(`echo [redacted] ${"y".repeat(500 - 16)}`);
  expect(redact(`approve ${token}`, 12)).toBe("approve [red");
  const value = `MY_TOKEN=${letters(5000)}`;
  expect(redact(`run ${value}`)).toBe("run MY_TOKEN=[redacted]");
});

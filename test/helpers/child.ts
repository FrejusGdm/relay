// A small program for test/adapters/process.test.ts, started as `bun child.ts <options>`:
//   --report <file>   writes {"stdin":"terminal"|"pipe"|"eof"} to the file when it starts
//   --print-mb <n>    prints n MB of 1 KB lines (every 512th also to standard error), then "done"
//   --split           prints one JSON line in two pieces, 200 ms apart
//   --partial <text>  prints the text without a newline just before it exits
//   --sleep <ms>      waits this long before it exits
//   --wait            prints "ready", answers each input line with "got <line>", exits with code n
//                     on "exit <n>" and with 0 at end of input; SIGINT prints "interrupted" and
//                     exits with 130
import { writeFileSync, writeSync } from "node:fs";
import { stdinKind } from "../fakes/record";

const args = process.argv.slice(2);
const option = (name: string) => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const partial = option("--partial");
const finish = (code: number): never => {
  if (partial !== undefined) writeSync(1, partial);
  process.exit(code);
};

const report = option("--report");
if (report !== undefined) writeFileSync(report, JSON.stringify({ stdin: stdinKind() }));

const megabytes = Number(option("--print-mb") ?? 0);
for (let start = 0; start < megabytes * 1024; start += 64) {
  let out = "";
  for (let i = start; i < start + 64; i++) {
    out += `${i} `.padEnd(1023, "x") + "\n";
    if (i % 512 === 0) writeSync(2, `err line ${i}\n`);
  }
  writeSync(1, out);
}
if (megabytes > 0) writeSync(1, "done\n");

if (args.includes("--split")) {
  writeSync(1, '{"type":"assis');
  await sleep(200);
  writeSync(1, 'tant","n":1}\n');
}

if (args.includes("--wait")) {
  process.on("SIGINT", () => {
    writeSync(1, "interrupted\n");
    finish(130);
  });
  const alive = setInterval(() => {}, 60_000);
  writeSync(1, "ready\n");
  let pending = "";
  for await (const chunk of Bun.stdin.stream()) {
    pending += new TextDecoder().decode(chunk);
    let newline: number;
    while ((newline = pending.indexOf("\n")) !== -1) {
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      const exit = /^exit (\d+)$/.exec(line);
      if (exit) finish(Number(exit[1]));
      writeSync(1, `got ${line}\n`);
    }
  }
  clearInterval(alive);
}
await sleep(Number(option("--sleep") ?? 0));
finish(0);

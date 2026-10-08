import { expect, test } from "bun:test";
import { JsonLineParser, LineSplitter } from "../../src/adapters/lines";

const encode = (text: string) => new TextEncoder().encode(text);

test("a line split across two chunks is passed on once, when its newline arrives", () => {
  const splitter = new LineSplitter();
  expect(splitter.push(encode('{"type":"assis'))).toEqual([]);
  expect(splitter.push(encode('tant"}\n{"type":'))).toEqual(['{"type":"assistant"}']);
  expect(splitter.push(encode('"result"}\n'))).toEqual(['{"type":"result"}']);
  expect(splitter.end()).toEqual([]);
});

test("a character split between two chunks is decoded whole", () => {
  const splitter = new LineSplitter();
  const bytes = encode("café ✓\n");
  expect(splitter.push(bytes.slice(0, 4))).toEqual([]);
  expect(splitter.push(bytes.slice(4, 8))).toEqual([]);
  expect(splitter.push(bytes.slice(8))).toEqual(["café ✓"]);
});

test("a 10 MB line arriving in 64 KB chunks is kept whole", () => {
  const splitter = new LineSplitter();
  const line = JSON.stringify({ type: "assistant", text: "x".repeat(10 * 1024 * 1024) });
  const bytes = encode(line + "\n");
  const lines: string[] = [];
  for (let start = 0; start < bytes.length; start += 64 * 1024) lines.push(...splitter.push(bytes.slice(start, start + 64 * 1024)));
  expect(lines).toHaveLength(1);
  expect(lines[0]!.length).toBe(line.length);
  expect(lines[0] === line).toBe(true);
});

test("a byte order mark at the start of the output is kept", () => {
  const splitter = new LineSplitter();
  expect(splitter.push(new Uint8Array([0xef, 0xbb, 0xbf, 0x61, 0x0a]))).toEqual(["\ufeffa"]);
});

test("a last line without a newline comes out at the end", () => {
  const splitter = new LineSplitter();
  expect(splitter.push("first\nlast")).toEqual(["first"]);
  expect(splitter.end()).toEqual(["last"]);
});

test("empty lines are passed on, and the parser ignores them without counting them", () => {
  const splitter = new LineSplitter();
  const parser = new JsonLineParser();
  const lines = splitter.push('{"a":1}\n\n   \n{"b":2}\n');
  expect(lines).toEqual(['{"a":1}', "", "   ", '{"b":2}']);
  expect(lines.map((line) => parser.parse(line))).toEqual([{ value: { a: 1 } }, null, null, { value: { b: 2 } }]);
  expect(parser.skipped).toBe(0);
});

test("a line that is not JSON is skipped and counted", () => {
  const parser = new JsonLineParser();
  expect(parser.parse("{not json")).toBeNull();
  expect(parser.parse('{"type":"brand_new_event","x":1}')).toEqual({ value: { type: "brand_new_event", x: 1 } });
  expect(parser.parse("Error: something")).toBeNull();
  expect(parser.skipped).toBe(2);
});

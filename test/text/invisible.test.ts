import { expect, test } from "bun:test";
import { removeInvisible } from "../../src/text/invisible";

// Each range of the list (design.md decision 4), first and last code point.
const RANGES: [number, number][] = [
  [0x00ad, 0x00ad],
  [0x061c, 0x061c],
  [0x180e, 0x180e],
  [0x200b, 0x200f],
  [0x2028, 0x2029],
  [0x202a, 0x202e],
  [0x2060, 0x2064],
  [0x2066, 0x2069],
  [0xfe00, 0xfe0f],
  [0xfeff, 0xfeff],
  [0xe0000, 0xe007f],
  [0xe0100, 0xe01ef],
];

test.each(RANGES.flatMap(([first, last]) => [first, last]).map((code) => [code.toString(16).toUpperCase(), code] as const))(
  "U+%s is removed",
  (_, code) => {
    expect(removeInvisible(`a${String.fromCodePoint(code)}b`)).toEqual({ text: "ab", removed: 1 });
  },
);

test.each([0x00ac, 0x00ae, 0x200a, 0x2010, 0x2027, 0x202f, 0x2065, 0x206a, 0xfdff, 0xfe10, 0xe0080, 0xe01f0].map((code) => [code.toString(16).toUpperCase(), code] as const))(
  "U+%s, next to a range, is kept",
  (_, code) => {
    const text = `a${String.fromCodePoint(code)}b`;
    expect(removeInvisible(text)).toEqual({ text, removed: 0 });
  },
);

test("a joined emoji loses its U+200D", () => {
  const family = "\u{1F468}‍\u{1F469}‍\u{1F467}";
  expect(removeInvisible(family)).toEqual({ text: "\u{1F468}\u{1F469}\u{1F467}", removed: 2 });
});

test("a text with nothing to remove comes back identical", () => {
  const text = "OAuth callback works: café, 東京, tab\there";
  const result = removeInvisible(text);
  expect(result.text).toBe(text);
  expect(result.removed).toBe(0);
});

test("text hidden in tag characters is removed whole", () => {
  const hidden = Array.from("ignore", (char) => String.fromCodePoint(0xe0000 + char.charCodeAt(0))).join("");
  expect(removeInvisible(`fix bug${hidden}`)).toEqual({ text: "fix bug", removed: 6 });
});

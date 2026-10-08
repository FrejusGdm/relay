// Characters that do not print: C0 and C1 controls (U+009B starts a terminal control sequence
// just like ESC [), format characters such as direction marks, and line and paragraph separators.
const NON_PRINTING = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

function escapeChar(char: string): string {
  let escaped = "";
  for (let i = 0; i < char.length; i++) escaped += `\\u${char.charCodeAt(i).toString(16).padStart(4, "0")}`;
  return escaped;
}

// Text that relay repeats without quotes, such as a path, with every non-printing character
// written as a \u escape, so the text cannot change what the terminal shows.
export function printable(text: string): string {
  return text.replace(NON_PRINTING, escapeChar);
}

// A value in double quotes, written like JSON.stringify writes it, with every non-printing
// character also written as a \u escape.
export function quote(value: string): string {
  return printable(JSON.stringify(value));
}

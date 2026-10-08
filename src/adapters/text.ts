// Encodes text as a TOML basic string, for Codex's `-c developer_instructions=<value>` (design
// decision 7). JSON.stringify escapes the quotation mark, the backslash and the control characters
// below U+0020 in forms TOML also reads. Two cases need more: TOML also requires U+007F to be
// escaped, and a lone surrogate has no TOML escape, so it becomes U+FFFD first.
export function tomlString(text: string): string {
  return JSON.stringify(text.toWellFormed()).replaceAll("\u007f", "\\u007f");
}

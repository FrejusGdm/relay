// Replaces secret-looking values with [redacted] in the facts relay writes to events.jsonl, such
// as the command lines an agent ran (add-provider-adapters, design decision 16;
// docs/research/security.md section 3). It is a filter for facts, not a replacement for the
// secret scan of checkpoints.
const REDACTED = "[redacted]";
// A shell word: quoted and unquoted pieces next to each other, ending at a space or at a
// character that separates commands. A quote that is never closed runs to the end of the text.
const VALUE = String.raw`(?:"(?:[^"\\]|\\.)*"?|'[^']*'?|[^\s"'&|;<>()])+`;

const TOKENS = [
  /sk-ant-[A-Za-z0-9_-]{10,}/g,
  /sk-[A-Za-z0-9_-]{20,}/g,
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /xox[abpr]-[A-Za-z0-9-]{10,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
];
// The part kept before the value: "Bearer ", "MY_TOKEN=" or "--password ".
const AFTER = [
  /(\bBearer\s+)[^\s"']+/gi,
  new RegExp(String.raw`(\b[A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY|APIKEY)[A-Za-z0-9_]*=)${VALUE}`, "gi"),
  new RegExp(String.raw`(--(?:password|token|api-key)(?:=|\s+))${VALUE}`, "g"),
];

export function redact(text: string): string {
  let result = text;
  for (const pattern of TOKENS) result = result.replace(pattern, REDACTED);
  for (const pattern of AFTER) result = result.replace(pattern, `$1${REDACTED}`);
  return result;
}

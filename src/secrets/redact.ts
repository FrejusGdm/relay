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
  // The lookahead finds the word in the name once and cannot be re-entered, so a long name
  // without "=" is scanned in linear time instead of once per position.
  new RegExp(String.raw`(\b(?=[A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY|APIKEY))[A-Za-z0-9_]+=)${VALUE}`, "gi"),
  new RegExp(String.raw`(--(?:password|token|api-key)(?:=|\s+))${VALUE}`, "g"),
];

// Only the first 4 KB are read, so a very long command cannot hold up relay while it drains an
// agent's output. The result is then cut to maxLength characters (500, the limit of a command in
// the event log, unless the caller gives less), which keeps it inside the part that was redacted.
const INPUT_LIMIT = 4096;

export function redact(text: string, maxLength = 500): string {
  let result = text.slice(0, INPUT_LIMIT);
  for (const pattern of TOKENS) result = result.replace(pattern, REDACTED);
  for (const pattern of AFTER) result = result.replace(pattern, `$1${REDACTED}`);
  return result.slice(0, Math.min(maxLength, INPUT_LIMIT)).toWellFormed();
}

// Replaces the value of every environment variable whose name ends in _KEY, _TOKEN, _SECRET or
// PASSWORD, and whose value has at least 8 characters, with [redacted: <NAME>] (add-relay-switch,
// design decision 9). Check output passes through it before any of it reaches checkpoint.md. Each
// line of a value that spans lines is also replaced on its own, so a value cut by line breaks
// still disappears. Every character covered by any value is replaced, longest values first, so
// two values that overlap in the text leave nothing of either.
const SECRET_NAME = /(?:_KEY|_TOKEN|_SECRET|PASSWORD)$/i;
const MIN_SECRET_LENGTH = 8;

export function redactEnvValues(text: string, env: Record<string, string | undefined>): string {
  const pieces: { name: string; value: string }[] = [];
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined || !SECRET_NAME.test(name) || value.length < MIN_SECRET_LENGTH) continue;
    for (const piece of new Set([value, ...value.split(/\r?\n/)])) {
      if (piece.length >= MIN_SECRET_LENGTH) pieces.push({ name, value: piece });
    }
  }
  pieces.sort((a, b) => b.value.length - a.value.length);
  const owner: (string | undefined)[] = new Array(text.length);
  for (const { name, value } of pieces) {
    for (let at = text.indexOf(value); at !== -1; at = text.indexOf(value, at + 1)) {
      for (let i = at; i < at + value.length; i++) owner[i] ??= name;
    }
  }
  let result = "";
  for (let i = 0; i < text.length; i++) {
    const name = owner[i];
    if (name === undefined) result += text[i];
    else if (owner[i - 1] === undefined) result += `[redacted: ${name}]`;
  }
  return result;
}

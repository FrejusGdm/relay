import { SettingsError } from "../../cli/errors";
import { parseToml } from "../../platform/toml";
import { printable } from "../quote";
import { readPrivateFile } from "../relay-home";
import type { RelayConfig } from "./types";
import { emptyConfig, validateConfig } from "./validate";

const MAX_CONFIG_BYTES = 1_048_576;

// Reads <relay folder>/config.toml. A missing file gives the empty settings and creates nothing.
// Any other problem throws a SettingsError whose lines never show a settings value.
export function loadConfig(opts: { relayHome: string; homedir: string; uid: number }): RelayConfig {
  const empty = emptyConfig(opts.relayHome);
  const { file } = empty;
  const text = readPrivateFile(file, opts.uid, MAX_CONFIG_BYTES);
  if (text === null) return empty;

  let raw: unknown;
  try {
    raw = parseToml(text);
  } catch (error) {
    throw new SettingsError([`relay: cannot read ${printable(file)}: ${withoutFileText((error as Error).message)}`]);
  }

  const { config, problems } = validateConfig(raw, opts);
  if (problems.length === 0) return config;
  const count = problems.length === 1 ? "1 problem" : `${problems.length} problems`;
  throw new SettingsError([
    `relay: ${printable(file)} has ${count}:`,
    ...problems.map(({ key, message }) => `  ${key}: ${message}`),
    "The settings are described in docs/config.md.",
  ], problems.length);
}

// Bun's TOML parser quotes part of the file in some messages, for example
// `Strings must be quoted: "<value>"`, and that part could be a credential. A quoted piece longer
// than three characters becomes "...", and an unclosed quote ends the message. Short pieces such
// as '=' or ']]' stay, so the message still says what is wrong.
function withoutFileText(message: string): string {
  let result = "";
  let i = 0;
  while (i < message.length) {
    const char = message[i]!;
    if (char !== '"' && char !== "'" && char !== "`") {
      result += char;
      i += 1;
      continue;
    }
    const end = message.indexOf(char, i + 1);
    if (end === -1) return printable(`${result}...`);
    const piece = message.slice(i + 1, end);
    result += piece.length <= 3 ? `${char}${piece}${char}` : `${char}...${char}`;
    i = end + 1;
  }
  return printable(result);
}

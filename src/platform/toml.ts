// The Bun-only TOML parser sits here so that a later move to another runtime changes one file.
export function parseToml(text: string): unknown {
  return Bun.TOML.parse(text);
}

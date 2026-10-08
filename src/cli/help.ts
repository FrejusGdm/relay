import type { CommandDef, OptionDef } from "./commands/registry";

const LOG_LEVEL_DESCRIPTION = "How much to log: debug, info, warn or error";

function optionRow(option: OptionDef): string {
  const long = `--${option.name}${option.value ? ` ${option.value}` : ""}`;
  const left = option.short ? `-${option.short}, ${long}` : `    ${long}`;
  return `  ${left.padEnd(23)}  ${option.description}`;
}

export function renderTopHelp(commands: CommandDef[]): string {
  return [
    "relay keeps your coding work moving between agents and accounts.",
    "",
    "Usage",
    "  relay <command> [options]",
    "",
    "Commands",
    ...commands.map((def) => `  ${def.name.padEnd(20)}${def.summary}`),
    "",
    "Options",
    optionRow({ name: "help", short: "h", description: "Show help" }),
    optionRow({ name: "version", description: "Show the version" }),
    optionRow({ name: "log-level", value: "<level>", description: LOG_LEVEL_DESCRIPTION }),
    "",
    'Run "relay <command> --help" for details about one command.',
    "Settings live in ~/.relay/config.toml, or in $RELAY_HOME/config.toml when RELAY_HOME is set.",
  ].join("\n") + "\n";
}

export function renderCommandHelp(def: CommandDef): string {
  const lines = [
    "Usage",
    `  ${def.usage}`,
    "",
    `${def.summary}.`,
    ...def.details,
    "",
    "Examples",
    ...def.examples.map((example) => `  ${example}`),
    "",
    "Options",
    ...def.options.map(optionRow),
    optionRow({ name: "help", short: "h", description: "Show this help" }),
    optionRow({ name: "log-level", value: "<level>", description: LOG_LEVEL_DESCRIPTION }),
  ];
  if (!def.built) lines.push("", "Not built yet. This version only reads your settings.");
  return lines.join("\n") + "\n";
}

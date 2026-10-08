<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.svg">
    <img src="assets/logo-light.svg" alt="relay" width="196">
  </picture>
</p>

# relay

A scheduler and continuity layer for coding agents. When Claude Code, Codex or
another coding agent you use stops, for example at its usage limit, relay moves the
job to another of your agents, with the same repository, plan and decisions.
Agents own cognition; relay owns state.

## What relay does, and what it does not do

relay works with the coding agents you already use and pay for yourself, such as
Claude Code and Codex. When one of them stops, for example at its usage limit, relay
saves your work and hands the job to another of your agents, with the same code, plan
and decisions.

- relay only starts the official programs you installed and signed in to yourself
  (`claude`, `codex`). It does not use private APIs, scrape screens or change those
  programs.
- relay never reads, copies, stores or shares your logins, tokens or API keys. Each
  tool keeps its own sign-in. The one exception: if you connect relay to T3 Code, relay
  keeps the access token T3 gives it, in your operating system's credential store only.
- relay does not pool, share or rotate accounts to get around a provider's limits or
  terms. It moves your work between different tools, each used under its own
  provider's terms.
- If you have more than one account with the same provider, for example a personal
  and a work subscription, relay switches between them only when you ask it to. It
  never does so on its own.
- The first handoff to a different company's tool asks for your confirmation, because
  it sends your code to that company.


**Status:** early preview (v0.1.0): the command-line tool installs and checks its settings; the handoff itself is being built. Read [VISION.md](VISION.md) for the idea,
[docs/ROADMAP.md](docs/ROADMAP.md) for the plan and the open decisions, and
[DESIGN.md](DESIGN.md) for the design direction.

relay's core is free and stays free; a one-time payment for a lifetime license will unlock the
paid features, and [docs/licensing.md](docs/licensing.md) explains how the license works.

## Install

relay is free and open source. These commands download the latest release from GitHub and
need no GitHub account. On macOS (Apple silicon):

```sh
mkdir -p "$HOME/.local/bin"
curl -fsSL -o "$HOME/.local/bin/relay" \
  https://github.com/FrejusGdm/relay/releases/latest/download/relay-darwin-arm64
chmod +x "$HOME/.local/bin/relay"
"$HOME/.local/bin/relay" --version
```

On Linux (x64), use `relay-linux-x64` in place of `relay-darwin-arm64`. To run `relay` by
name, add `~/.local/bin` to your PATH, for example with `export PATH="$HOME/.local/bin:$PATH"`
in `~/.zshrc` on macOS or `~/.bashrc` on Linux.

## Usage

Set up relay in a project, add an account, and start an agent inside the job:

```sh
cd ~/projects/app
relay init --title "Add the parser"
relay account add claude personal --profile-dir ~/.claude
relay run claude:personal
```

`relay run` gives your terminal to the agent and records what it did in `.relay/events.jsonl`.
To let the agent work on its own, give it a task:

```sh
relay run claude:personal --headless --prompt "Fix the failing test."
relay checkpoints
```

A headless run prints one line per command and changed file, and exits with 23 when the agent
stops at a usage limit. [docs/cli.md](docs/cli.md) lists every command, and the section "Running
an agent" of [docs/adapters.md](docs/adapters.md) explains `relay run`.

## Repository layout

| Path | What it is |
|---|---|
| `VISION.md` | The idea behind relay |
| `docs/research/` | Provider control surfaces, architecture, security, prior art and pricing, lessons from jstack, published advice on agent handoffs, T3 Code's door for outside programs |
| `docs/ROADMAP.md` | Phases, and the decisions still open |
| `docs/first-version-index.md` | Every command, exit code, event, job file and module of the first version |
| [docs/architecture.md](docs/architecture.md), [docs/progress.md](docs/progress.md) | How relay works, and how far the build has come, with diagrams |
| [Codebase map](docs/codebase-map.md) | The folders of the source code and tests, with a diagram |
| [docs/cli.md](docs/cli.md) | The `relay` command line: commands, output and exit codes |
| [docs/daemon.md](docs/daemon.md) | The background service: its files, the `relay daemon` commands and the private socket |
| [docs/adapters.md](docs/adapters.md) | How relay starts, watches and stops Claude Code and Codex, and the events adapters report |
| [docs/accounts.md](docs/accounts.md) | Adding, checking and removing accounts, profile folders, and what relay never stores |
| [docs/testing-adapters.md](docs/testing-adapters.md) | The fake agents and scenario files that tests use instead of real providers |
| [docs/api.md](docs/api.md) | The daemon's local API: every endpoint, the event stream and the errors |
| [docs/mac-app.md](docs/mac-app.md) | The Mac menu-bar app: install, first launch, how it talks to the daemon, and how it is built |
| `DESIGN.md`, `docs/design/` | The design direction and its working preview |
| `site/` | The public website, deployed to Azure Static Web Apps; see [docs/website.md](docs/website.md) |
| `license-server/` | The server that sells and delivers the lifetime license with Stripe Checkout; see [docs/licensing.md](docs/licensing.md) |
| `openspec/` | Project rules (`config.yaml`) and detailed change proposals for the first version |
| `AGENTS.md`, `CLAUDE.md` | Instructions for coding agents |

## Development

To install, test and build relay, follow [docs/development.md](docs/development.md).

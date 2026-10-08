# relay — Vision

Read this before building anything. It describes the idea behind relay. It is not a
fixed specification: when building teaches us something better, we change this file.
Claims about other products must be verified before we rely on them; see
`docs/research/`.

## The problem

A developer today pays for several coding agents: Claude Code, Codex, Cursor. Each is
an island. When one hits its usage limit, the
work stops, and moving it to another agent means rebuilding the context by hand.
Long jobs with many parallel agents die all at once when a limit or an outage hits.
The tools you already pay for do not work together.

## What relay does, and what it does not do

relay works with the coding agents you already use and pay for yourself, such as
Claude Code and Codex. When one of them stops, for example at its usage limit, relay
saves your work and hands the job to another of your agents, with the same code, plan
and decisions.

- relay only starts the official programs you installed and signed in to yourself
  (`claude`, `codex`). It does not use private APIs, scrape screens or change those
  programs.
- relay never reads, copies, stores or shares your logins, tokens or API keys. Each
  tool keeps its own sign-in.
- relay does not pool, share or rotate accounts to get around a provider's limits or
  terms. It moves your work between different tools, each used under its own
  provider's terms.
- If you have more than one account with the same provider, for example a personal
  and a work subscription, relay switches between them only when you ask it to. It
  never does so on its own.
- The first handoff to a different company's tool asks for your confirmation, because
  it sends your code to that company.

## What relay is

relay is **a scheduler and continuity layer for coding agents**. It sits underneath
or beside the tools you already use and keeps your work moving across them.

It is not another coding agent and not a harness: Claude Code, Codex, Cursor and
OpenCode are harnesses, and relay coordinates them. It is not an MCP server (that
gives models tools) and not mainly an API (it may expose one). The closest standard
terms are **orchestrator**, **scheduler** and **control plane**.

The principle the whole product is built around:

> **Agents own cognition. relay owns state.**

relay never tries to move one provider's hidden conversation into another. It owns a
portable, provider-independent record of the job, and any agent can pick the job up
from it.

## How it works

### The job is the unit of work, not the conversation

A relay job holds everything another agent needs to continue:

- the goal and acceptance criteria;
- the current plan and what is done, in progress and left;
- the decisions made and why;
- the repository state: branch or worktree, base commit, latest checkpoint commit,
  files touched;
- test and lint results, known failures;
- a short summary of relevant conversation, never the full transcript by default;
- the current worker and every earlier worker, with their provider session IDs.

Context comes in tiers. Almost always the next agent needs only the first two:
(0) the repository, the diff, the task and acceptance criteria; (1) the plan,
decisions, checkpoint summary, and test results. Selected tool calls or conversation
excerpts (2) and the raw transcript (3) are rarely worth their cost.

### Files are the common language

Every agent understands files, so relay keeps the job in the project:

```
.relay/
  task.md          goal, acceptance criteria, current plan
  state.json       machine-readable job state
  checkpoint.md    the latest handoff, written for the next agent
  decisions.md     decisions and their reasons
  events.jsonl     append-only log of facts
AGENTS.md          read by Codex, Cursor and others automatically
```

The **event log** records facts (task started, file modified, command run, test
result, decision, checkpoint, agent exhausted, handoff), because summaries can omit
or invent things. The next agent gets the task, the checkpoint, the repository and the
relevant events, and is told to verify the checkpoint's claims.

### Checkpoints are git-native

Every meaningful handoff is a commit (or a worktree snapshot). `relay rollback`
returns to the last good checkpoint if the next agent makes a mess. Agents become
disposable; the work does not.

### A handoff, step by step

1. Stop the current agent cleanly.
2. Capture git status, diff, recent commits, test status, task and state.
3. Ask the outgoing agent for a concise handoff when it still can; otherwise build it
   from the event log and the repository.
4. Write `checkpoint.md` and a checkpoint commit.
5. Start the next agent with: read `AGENTS.md`, `.relay/task.md` and
   `.relay/checkpoint.md`, inspect the worktree and diff, verify the checkpoint, and
   continue.

### Adapters, not screen scraping

relay talks to each tool through what it officially exposes: command-line modes,
SDKs, session and resume features, local servers and protocols. Each provider gets
one adapter (start, send, interrupt, resume, checkpoint, availability). The core
knows nothing about any provider's internals. Desktop apps are views; the runtime
underneath is what relay drives. Automating mouse clicks is the last resort.

### Availability, accounts and capacity

Each adapter reports availability: available, rate limited (retry at), quota
exhausted (retry at), unavailable, or unknown, from supported signals where they
exist (usage commands, exit codes, known messages) and from an explicit user command
otherwise.

Accounts are first class. A worker runs on an **execution target** such as
`claude:personal`, `claude:startup`, `codex:personal` or `cursor:work`, each with its
own isolated profile directory, so two accounts of the same provider can run on one
computer. Moving work from `claude:personal` to `claude:startup` is the same
operation as moving it from Claude to Codex. relay supports accounts a person
legitimately holds, within each provider's terms; it is not a tool for evading
limits, and each adapter carries that provider's policy.

### From failover to scheduling

The first value is simple: when one agent stops, another continues. The larger idea
is **one continuous coding session across every agent you pay for**, scheduled like
compute. Five primitives:

| Primitive | Meaning |
|---|---|
| Provider | Claude Code, Codex, Cursor, and each account of them |
| Worker | an active agent session |
| Task | a unit of work, part of a task graph |
| Workspace | a git worktree (or container) |
| Lease | a worker's time-limited claim on a task, renewed by heartbeats |

When a provider stops, its leases expire and the tasks become schedulable again,
from their last checkpoint. A provider's reset time is a scheduling event, not a
retry loop. The scheduler weighs fit for the task, remaining capacity, speed, and the
**cost of moving** work: an agent that is almost done is left alone, and returning
capacity is used for new work rather than churning running tasks. Parallel agents
never share a working tree; each gets its own worktree, and an integrator merges.

### Where it lives

- **relay core:** a local daemon and command-line tool, open source.
- **A small local API** (for example on `localhost:7331`) so any client can use it:
  the terminal, T3 Code, Codex, Claude, Cursor, editors.
- **relay for Mac:** a small menu-bar app, closer to Raycast and Activity Monitor
  than to an IDE: the jobs that are running, the capacity of every account, reset
  times, and one tap to open the job wherever it now runs. A job has one identity
  (`relay://job/184`) no matter which tool is working on it.
- **Integrations** at three levels: native (a client such as T3 Code supports relay
  directly), runtime (relay drives the runtime under a desktop app), and external
  handoff (checkpoint, open the other tool, hand it the context).
- **Lineage:** every job shows which agent worked when, and what each did. It becomes
  the history of how the software was built.

## The first version

Small, for the founder first, with no automatic detection yet:

```
relay init        set up .relay/ in a project
relay run         start an agent inside a relay job
relay checkpoint  write the handoff and a checkpoint commit
relay switch <provider[:account]>   hand the job to another agent
relay status      the job, its workers, capacity and checkpoints
relay rollback    return to the last checkpoint
```

Adapters for Claude Code and Codex first; Cursor and T3 Code next. Manual switching
first, automatic failover after. The demo that proves it: start in Claude, hit the
limit, open Codex and the work is already continuing; later open T3 Code and
supervise both, without rebuilding context once.

## Positioning

T3 Code is an open-source control surface for coding agents; according to the notes
it recently added switching providers inside a thread. Get One keeps agents running
in their own apps and adds an always-on toolbar. relay's wedge is different:
**where work runs** (scheduling, capacity pooling across accounts, recovery,
multi-agent continuity), not another interface for chatting with agents. relay
should work with T3 Code, not compete with it.

## Design direction (from the notes, to be confirmed in `DESIGN.md`)

- Feels like a system utility Apple might make for coding agents: mostly black and
  off-white, tight type, thin rules, subtle motion.
- The hero is one live object: the relay card. Claude's capacity drains, hits its
  limit, a thin line travels down, Codex lights up: "Continuing on Codex". No
  spinner, no drama.
- A visual language of **flow and continuity**: thin paths passing work between
  lanes, a baton passing. Not lightning bolts, not AI sparkles, no purple gradients,
  no robot orbs, no wall of logos.
- Progressive disclosure: a tiny card by default, details on demand.
- A little developer irreverence in the copy.

Copy ideas from the notes: "Never stop coding because an agent did." "Your agents
should be disposable. Your work shouldn't be." "One pool. Every agent." "Same repo.
Same decisions. Same task. Different worker." "relay is free. You already paid for
the agents."

## Business

relay is free and open source (Apache 2.0). Nothing is paid and nothing is locked:
there are no paid features and no license key. Josué decided this on 2026-10-09, in
his words: "let's make it all free and not gatekeep something". It replaces the
earlier plan of a one-time lifetime license for paid features. relay never takes a
share of what people spend on agents.

## Open questions

- Exactly what each tool exposes today for control, resume, usage and limits (Claude
  Code, Codex CLI and app server, Cursor CLI, T3 Code, OpenCode), and what each
  provider's terms say about multiple accounts and automated switching.
- Language and runtime for the daemon and CLI; technology for the Mac app.
- How the local API is secured against other software on the machine.
- How relay notices an agent stopped, when the agent runs inside an app relay did not
  start.
- The landing page and brand (`DESIGN.md`).

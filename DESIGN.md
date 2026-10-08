# Design System — relay

This is relay's current design direction, from the design consultation of
2026-10-07. It is not final: Josué may change any part of it. Until then, read it
before any visual or user-facing work (the website, the Mac app, CLI output) and do
not deviate from it without his approval. The working preview is
`docs/design/preview.html`.

## Product context

- **What this is:** a scheduler and continuity layer for coding agents. When one
  agent hits its usage limit, relay moves the job to another agent or account with the
  same repository, plan and decisions.
- **Who it is for:** developers who pay for several coding agents (Claude Code,
  Codex, Cursor) and lose time switching between them by hand.
- **Surfaces:** the command-line tool, a small always-on Mac menu-bar card, and the
  landing page.

## The idea

A railway track diagram, printed on warm paper. Accounts are lanes; the job is a baton
that steps down to another lane when one runs dry. Two principles drive every screen:

- **The job stays still; the worker changes.** The job title, repository and
  checkpoint never move during a handoff. Only the worker changes.
- **Agents own cognition. relay owns state.** Show saved state (checkpoint, decisions,
  tests) more prominently than activity.

## Rules

1. **No labels above titles**, no numbered section labels, no uppercase monospaced
   captions.
2. **Clarity before cleverness.** If a line, a bar or a dot needs explaining, label it
   in words or remove it. The founder found the first card's unlabelled lanes and
   the capacity graph confusing.
3. **Quiet backgrounds.** Background line art has no text: no account names, no hashes.
4. **Honest data.** Show capacity only when a provider actually reports it, with what
   was measured and when. Never add percentages from different providers together.
   Illustrations are captioned "Illustrated". No promise of automatic failover before
   it exists.
5. **Tell the pain in time, not in charts.** The problem relay solves is the time lost
   switching by hand; show it as a timeline (by hand: about 46 minutes; with relay:
   about one minute), not as capacity bars.
6. **Never color alone.** Every status has a word.
7. **No generic AI look:** no gradients, glow, blur, sparkles, robots, lightning bolts,
   provider logo walls, blue or purple accents, nested cards or six-box feature grids.
8. **Add nothing that was not asked for.**

## Typography

| Role | Typeface | Notes |
|---|---|---|
| Headlines | **Satoshi** 700–900 (Fontshare) | Tight letter spacing (−0.025em), line height about 1.05 |
| Text, interface, numbers | **Public Sans** 400–600 | Tabular figures where numbers change |
| Commands, hashes, times, account IDs | **IBM Plex Mono** 400–500 | Never for headings or whole paragraphs |

Kept as alternatives in the preview: Manrope, Newsreader, Geist.

## Color

Light is the default; dark is a full theme. Olive is the accent; ink (no accent) is
the alternative.

| Token | Light | Dark | Use |
|---|---|---|---|
| `--bg` | `#F4F2EC` | `#0D0D0C` | Page |
| `--surface` | `#FBFAF7` | `#161614` | Cards, panels |
| `--raised` | `#FFFFFF` | `#1E1E1B` | The one raised element in a view |
| `--rule` | `#D8D5CC` | `#2B2A27` | Lines, idle lanes |
| `--muted` | `#6E6B63` | `#8A877F` | Secondary text |
| `--ink` | `#141413` | `#EDEBE4` | Text, active lane |
| `--accent` | `#52613A` | `#BDCDA0` | The active worker, the primary action, the baton |
| `--accent-soft` | `#E6EADC` | `#2A3122` | Accent backgrounds |
| `--warning` | `#855313` | `#E2BD7C` | "Limit reached", with the word |
| `--error` | `#B3261E` | `#E0574F` | Failures, with the word |
| `--success` | `#426044` | `#AFC79E` | Passed checks, with the word |

## Layout

- **Landing page:** spacious, composed like a poster. Content width about 1200px,
  sections 96–144px apart, uneven columns, thin rules between sections.
- **The card:** about 360–380px expanded, about 280px tiny. Radius 12px, 1px border,
  one shallow shadow only on the floating Mac panel. Strict order: the job, one status
  line in words, the handoff as a labelled flow from the previous worker to the
  current one, checkpoint and test facts as a small aligned list, one primary action.
- **Terminal output:** aligned plain text in ordinary words; the same lanes and the
  same closing sentence as the card ("Continuing on Codex."). Readable without color.

## Motion

Plain CSS animation (no motion library), only `transform` and `opacity`, paused when
off-screen, and a still final state for people who reduce motion. Follow Emil
Kowalski's skills when building it.

| Token | Value | Use |
|---|---|---|
| `--ease-out` | `cubic-bezier(0.22, 1, 0.36, 1)` | Everything that appears or moves |
| press | 100ms | Button feedback |
| text | 120ms | Status text changes |
| expand | 180ms | Card expanding |
| story | about 6–8s | The landing page handoff, played once, with Replay and Pause |

In the real app, states change only on confirmed events, never on a timer.

## Copy

- Hero lines are short, bold and promise-first. Current favorite: **"Never run out of
  limits again."** The line under it keeps the promise honest ("When one coding agent
  hits its limit, relay moves the work to another you already pay for, with the same
  code, plan and decisions.").
- Closing line: "Your agents should be disposable. Your work shouldn't be."
- A little developer irreverence is welcome; "seamless", "supercharge" and
  "autonomous workforce" are not.

## Change log

| Date | Choice | Rationale |
|---|---|---|
| 2026-10-07 | Railway track idea, ink and olive on warm paper | Outside voices (Codex and a Claude agent) converged; references Get One, Clerk, T3 Code |
| 2026-10-07 | Satoshi headlines, olive accent, light default | Founder's choice |
| 2026-10-07 | Headline "Never run out of limits again." | Founder's line; earlier options were unclear |
| 2026-10-07 | No text in background art; pain told as a timeline | Founder found the labelled background and the capacity graph confusing |

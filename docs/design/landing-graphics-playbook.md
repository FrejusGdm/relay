# Landing-page graphics playbook

Use this process when simplifying software diagrams or animations on a landing
page, or when Josué asks for the same quality as the relay redesign. Saved on
2026-10-08 after Josué liked the revised HTML preview.

The result to study is [animation-proposal.html](animation-proposal.html), with
`?graphics=simple`. Its bottom control compares the proposed and original graphics.
This is a review prototype. Production implementation is a separate task.

## Start with this prompt

> Read this playbook and inspect the existing page before editing. Improve its
> graphics and animations while preserving the copy, fonts, type sizes, colors,
> section order and page layout unless I explicitly ask to change them. Research
> real software diagrams and inspect the reference images. Use real SVG or PNG
> logos from my repositories or official brand assets. Give each graphic one clear
> relationship, keep it understandable as a still image, and animate only the
> state changes that explain the product. Present a reviewable HTML with an
> original/proposed comparison. Verify it at desktop and mobile widths, in light
> and dark themes, and with reduced motion. Explain the visual decisions briefly.

For a new page, first establish its own copy, typography and palette. Use relay's
styling below only when I request this visual direction. Follow the new project's
instructions and approval requirements.

## Process

### 1. Preserve the page's identity

Read the product description, design direction and existing page. Inspect the
rendered page and its CSS. Record which parts are authorized to change before
building the prototype.

For a graphics-only request, reuse the existing markup, stylesheet and content.
Add narrowly scoped graphic overrides. Include dynamic status text, captions,
timestamps and task names in the content that must be preserved. Keep explanatory
review controls separate from the product UI.

**Done when:** the scope is explicit and the original page is available for
comparison. The viewer can judge the graphics without also judging a new font or
rewritten headline.

### 2. Research the right kind of diagram

Inspect examples from actual software, including screenshots or animations. Match
the reference to the relationship being explained: a dependency graph for tasks,
a timeline for elapsed time, a path for continuity, or a transfer for a handoff.
Record what the example makes easier to understand and how that applies here.

For relay, we studied GitHub Actions, Trigger.dev, Dagster, Temporal and n8n.
Their useful patterns were fixed nodes, quiet connectors, visible ports, event
spines, recognizable tool symbols and detail revealed on selection. See
[the research notes](../research/landing-graphics-references.md) for inspected
examples and first-party source links. Borrow these patterns in the project's own
visual language.

**Done when:** each proposed diagram has a concrete reference and a stated reason
for using that structure. If a reference service is unavailable, continue with
official product documentation and images; record the limitation.

### 3. Find real assets before drawing symbols

Search the current repository, then Josué's related repositories, for existing
SVG or PNG assets. Prefer a clean SVG for logos; use a suitable PNG when that is
the supplied asset. If the logo is missing, use the provider's official assets or
keep the tool name visible while resolving the asset. Never invent a substitute
brand mark.

In this project, the actual assets came from:

```text
/Users/josuegodeme/Downloads/projects/fortynine/services/api-server/src/assets/client-marks/
  claude.svg
  openai.svg
  cursor.svg
```

Exact copies are saved in [animation-assets](animation-assets/). Claude's burst
identifies Claude Code; the OpenAI mark appears beside the Codex label; Cursor
uses its own mark. The OpenAI mark is an OpenAI logo, not a separately sourced
Codex logo. T3 Code and OpenCode remained text labels because this asset set did
not contain their logos.

Keep the original geometry and brand colors. Normalize the visible bounds and
optical size so a logo with extra whitespace does not look smaller than its
neighbor. We tightened OpenAI's display viewBox while preserving its paths and
keeping the copied source file intact. Check monochrome marks against both themes;
we inverted OpenAI and Cursor for the dark theme and retained Claude's terracotta.
Prefer official light/dark variants when available.

Place logos on the objects they identify, beside readable names. Use empty alt
text when the neighboring name already supplies the identity. Connectors, ports
and checkpoint objects can still be drawn in HTML/CSS/SVG: those explain the
relationship rather than impersonating a brand.

**Done when:** every displayed provider mark has an identifiable source, readable
sizing and theme contrast. Preserve asset provenance in the project.

### 4. Compose a still image that explains the product

Give each graphic one primary relationship. Keep the important object in place,
put state on that object, and attach connectors to identifiable endpoints. Use
spacing, alignment and line weight to establish hierarchy. Let the graphic answer
a specific question before adding motion.

| Relay graphic | What it answers | Proposed treatment |
|---|---|---|
| Hero handoff | What survives when the worker changes? | Two real worker logos flank a fixed saved checkpoint. Job identity and checkpoint facts stay in place. |
| Time comparison | How much time is lost switching? | Two execution traces share the 14:19–15:05 extent; every original event and timestamp remains below. |
| Lineage | Who worked on this job, and when? | One continuous path passes through the original accounts and checkpoints; mobile uses a vertical trace. |
| Parallel tasks | What depends on what, and what pauses? | Preserve all nine tasks and eleven dependencies; use three branches, a merge and a review with fixed nodes and rounded connectors. |

The dependency graph also lets a viewer select a task to highlight its immediate
connections. Keep these controls useful and secondary. Reflow the diagram for
small screens instead of shrinking the entire desktop canvas into illegibility.

**Done when:** the first, intermediate and final states remain understandable with
animation paused. Every line has a meaning, and every status has a word. Preserve
the actual graph data and distinguish dependencies from worker handoffs. Keep
illustrated data identified as illustrated.

### 5. Add motion to explain the transition

Write down the states first. Relay's hero sequence is working, usage running out,
limit reached, saving checkpoint, moving the job, then working on Codex. The
checkpoint stays fixed while worker state changes around it.

Use short opacity and transform transitions for local changes. The preview uses
180–250 ms entrances with at most a 3 px translation and the easing
`cubic-bezier(0.22, 1, 0.36, 1)`. Its hero story lasts 7.2 seconds. The graph advances
through three phases over 15 seconds, then holds the final state. These are
illustration timings, not a model for real product events.

Provide Pause and Replay, pause when the page is hidden or the graphic is off
screen, and show a useful final state under reduced motion. The proposed graph
uses fixed connectors and changing task states; moving particles were removed.
Use simple CSS and browser animation APIs when sufficient. Drive real product
state from confirmed events.

**Done when:** playback can be stopped and replayed, reduced motion works, and the
viewer can understand both the cause and outcome of the transition.

### 6. Present, inspect and verify

Save a reviewable HTML and provide a clearly separate original/proposed control.
Embed small SVG assets when a portable HTML is useful; keep original asset files
alongside it. Preserve the established font families and weights. If local font
files are unavailable, use the project's existing official font sources and make
that dependency clear.

Inspect desktop and mobile layouts, both themes, the important animation states,
keyboard focus and reduced motion. Check that logos are crisp, labels fit, ports
meet connectors, controls work and the page does not overflow horizontally.
Compare content and inherited typography against the original. Parse embedded SVGs
and scripts and confirm all graph relationships survived.

**Done when:** the artifact is accessible, the checks are reported accurately, and
the visual review covers the changed graphics. If browser access is blocked,
record that gap and request visual review through an available approved surface.
Do not claim a rendered check from a syntax check.

## Relay styling reference

These values describe the liked prototype. The existing page stylesheet was the
source for typography and tokens. On another project, preserve its own system
unless Josué requests this palette and type pairing.

| Role | Typeface and treatment |
|---|---|
| Headlines | Satoshi, weight 500, letter spacing −0.035em, line height 1.02. The existing display scale is 0.86. |
| Body and interface | Public Sans, weights 400–600. Body is 16 px with line height 1.55; the hero description is 20 px with line height 1.5. |
| Commands, hashes, times and account IDs | IBM Plex Mono, weights 400–500. Use it for technical facts rather than entire paragraphs. |
| Changing numbers | Tabular figures so values do not shift while updating. |

`DESIGN.md` recommends heavier Satoshi headings, but this graphics-only prototype
preserved the page's existing weight of 500. Read the implementation when matching
an existing page; reconcile broader design changes separately.

| Token | Light | Dark |
|---|---|---|
| Page background | `#F4F2EC` | `#0D0D0C` |
| Surface | `#FBFAF7` | `#161614` |
| Raised surface | `#FFFFFF` | `#1E1E1B` |
| Rules and idle connections | `#D8D5CC` | `#2B2A27` |
| Secondary text | `#6E6B63` | `#8A877F` |
| Main text | `#141413` | `#EDEBE4` |
| Olive accent | `#52613A` | `#BDCDA0` |
| Warning | `#855313` | `#E2BD7C` |
| Error | `#B3261E` | `#E0574F` |
| Success | `#426044` | `#AFC79E` |

The page feels like a railway diagram printed on warm paper. Most of the surface
is neutral. Olive identifies active state and the primary action; warning colors
accompany explicit status words. Provider colors belong to the authentic logos.
Keep backgrounds quiet and use thin rules rather than decorative effects.

The inherited content container is 1248 px wide with 24 px side padding. Desktop
sections have 128 px vertical padding, stepping down to 112 px and 96 px. The hero
uses uneven columns and a 374 px graphic. Graph nodes use 8 px corners, 1 px borders,
small ports and roughly 1.2–1.6 px connector strokes. These measurements establish
the reference's spacious page and compact diagrams; adapt them to actual content.

## What the iteration taught us

The first proposal changed fonts and copy beyond the requested graphics scope.
Josué corrected that. The next treatment simplified the graph into a flat list,
which he also rejected. Researching real software led to a clearer diagram while
retaining the product's relationships. Generic provider symbols were then replaced
with real assets from fortynine. Josué liked that revised result.

The repeatable lesson is to reduce visual competition while preserving meaning:
recognizable tools, fixed objects, quiet connections, explicit states and measured
motion, all inside the page's established identity.

The recorded checks verified original SVG copies, valid embedded SVGs, JavaScript
syntax and selected inherited typography rules. A full rendered browser check was
blocked in this session. The prototype was reviewed by Josué in his open browser.
Future runs should complete the rendered checks in step 6 when access is available.

## Files to carry forward

Use this Markdown as the process. For a concrete visual reference, also supply the
[HTML prototype](animation-proposal.html) and [logo assets](animation-assets/).
Consult [DESIGN.md](../../DESIGN.md) for relay's broader direction and
[the research notes](../research/landing-graphics-references.md) when choosing
diagram structures. This file can be copied or attached to a future project; it
does not depend on a particular agent, plugin or paid reference service.

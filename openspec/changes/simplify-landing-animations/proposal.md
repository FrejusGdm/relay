# Proposal

## Why

Josué asked for a reviewable HTML proposal that simplifies the landing page's animations and graphs. The current hero combines a capacity bar, changing status text, a moving token, two worker panels and checkpoint facts. The task graph adds provider shapes, moving dots and a separate clock. These compete for attention.

## What changes

- Create a separate, review-only HTML at `docs/design/animation-proposal.html`. The request authorizes this prototype. Changes to `site/public/` remain pending Josué's choice and approval.
- Josué clarified that only the graphics should change. Rebuild the prototype from `site/public/index.html`, `styles.css`, `site.js` and `theme.js` so that the existing copy, font families, font weights, type sizes, page layout and section order remain intact. The first prototype exceeded this scope and is superseded.
- Compare the original graphics against the simplified graphics using a separate review control. This control is not part of the landing page.
- Josué rejected the flat task-list treatment and asked for references from other software. Research first-party examples in `docs/research/landing-graphics-references.md`. The new proposal keeps actual diagrams.
- Josué requested real logos from his coffeechats or fortynine repository. Reuse the Claude, OpenAI and Cursor SVGs from `fortynine/services/api-server/src/assets/client-marks/` in the review prototype. Replace generic provider symbols in the proposed handoff, graph and legend, and add the available marks to the provider row. Preserve the SVG paths and brand colors; adjust display bounds and dark-theme contrast where needed. Use the OpenAI mark beside Codex. Keep the original comparison graphics intact.
- Josué liked the revised preview and requested a reusable Markdown process for future projects. Save the workflow, asset provenance, styling reference, motion decisions, corrections and verification limits in `docs/design/landing-graphics-playbook.md`. This authorizes the documentation; it does not request production implementation.
- Replace the hero's unmeasured capacity bar with a compact worker-to-checkpoint-to-worker schematic. Keep one saved checkpoint object in place throughout the handoff. Preserve the existing job, status, checkpoint facts, controls and their text. Source: `DESIGN.md`, The idea and rules 2, 4 and 6; `docs/research/architecture.md`, section 5; `docs/research/landing-graphics-references.md`, sections 2 and 5.
- Keep every event and timestamp in the time comparison. Add two compact execution traces with the same time extent, with events below them. Source: `DESIGN.md`, rule 5; `docs/design/preview.html`, cost comparison; `docs/research/landing-graphics-references.md`, section 2.
- Draw lineage as one continuous path with rounded switches and checkpoint markers. Preserve the existing accounts, hashes and timestamps. Source: `DESIGN.md`, clarity before cleverness; `docs/research/landing-graphics-references.md`, sections 2 and 4.
- Redraw the actual dependency graph as three clear branches, a merge and a review, with compact fixed nodes, visible ports and rounded, subdued connectors. Preserve every task, worker, status, dependency, phase message and caption. Animate only the affected task states, then hold the final state. Source: `docs/research/architecture.md`, section 6; `docs/ROADMAP.md`, phase 9; `docs/research/landing-graphics-references.md`, sections 1 and 3.
- On 2026-10-09 Josué approved applying the proposed graphics to the production landing page and asked for the site to be redeployed afterwards. The production change ports the graphics into `site/public/index.html`, `styles.css` and `site.js` and leaves the copy, fonts, type sizes, colors, section order and layout as they were. It serves the logos from `site/public/logos/`: exact copies of `claude.svg` and `cursor.svg`, `openai.svg` with the tightened viewBox, and `openai-dark.svg` (the same mark filled white) for the dark theme inside the hero drawing, because not every browser applies CSS filters to SVG elements. The Original/Proposed comparison and the graph's moment buttons (17:40, 17:52, 18:00) stay in the review prototype only; the graph keeps Pause and Replay. On a phone the lineage reads as a vertical trace that ends at a dot on the "now" row.
- Play the hero once, with Pause and Replay, pause off screen and when the page is hidden, and show a still final state under reduced motion. Source: `DESIGN.md`, Motion; [MDN reduced motion](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/At-rules/@media/prefers-reduced-motion), [MDN animation playback](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/animation-play-state), checked 2026-10-08.

## Out of scope

Copy changes, typography changes, page redesign, backend changes, provider calls, installation, pricing changes and decisions marked open in `docs/ROADMAP.md`. No change to `DESIGN.md` is implied. The review controls are not proposed product UI.

## Security

The prototype launches no tools, reads no credentials, touches no git state and calls no local API. Optional font stylesheets use the same Google Fonts and Fontshare sources as the current design preview; system fallbacks work offline. The existing theme and install-copy controls are carried over from the page. Theme persistence is disabled for the prototype. There is no telemetry or form submission.

## Review

Open the HTML directly. Compare Original graphics and Proposed graphics using the bottom controls. The unchanged copy and typography provide the comparison context. Production work waits for Josué's approval. The referenced `jstack-design` skill was not found in the repository or installed skill directories; the prototype follows `DESIGN.md` and the available frontend-design and Emil design-engineering skills. Refero returned `NO_SUBSCRIPTION`; first-party screenshots and documentation were used instead.

# Tasks

## 1. Port the approved graphics to the landing page (approved 2026-10-09)

- [x] 1.1 Serve the provider logos from `site/public/logos/` and show them in the provider row, the hero, the lineage, the graph legend and the graph's tasks.
- [x] 1.2 Replace the hero's capacity bar, arrow and moving token with two worker logos around one fixed saved checkpoint, colored by the existing six stages.
- [x] 1.3 Add two execution traces on the shared 14:19 to 15:05 scale above the unchanged events and times.
- [x] 1.4 Draw the lineage as one continuous path, and as a vertical trace on a phone.
- [x] 1.5 Redraw the task graph with fixed tasks, visible ports, rounded quiet connectors and status words; make each task a button that highlights its connections; play once, hold the last moment, and add Pause and Replay.

Prove it on the Omarchy machine:

```bash
bun test site/test
bun run typecheck
SITE_PORT=4391 npx playwright test --config site/playwright.config.ts
```

## 2. Deploy

- [ ] 2.1 Merge, then deploy to production on the Omarchy machine with `bash site/scripts/deploy.sh`, which runs the smoke test.

# Proposal: the Mac menu-bar app (phase 8)

## Why

After phase 5, relay knows which agent works on each job, which account hit its limit and when
it resets, but the person sees it only by typing `relay status`. The vision asks for "a small
menu-bar app, closer to Raycast and Activity Monitor than to an IDE" that shows the running job,
where it went and how to open it, without opening a terminal (`VISION.md`, "Where it lives";
`docs/ROADMAP.md`, phase 8 "The Mac menu-bar app"). Josué approved building it on 2026-10-07
(`docs/ROADMAP.md`, "Decisions made": SwiftUI, built and tested on GitHub's macOS runners,
unsigned). This change describes it so that an agent can build it against the local API of
`add-daemon-api-and-status` after that change is merged.

## What Changes

- **A SwiftUI menu-bar app named relay, in `mac/`.** It uses `MenuBarExtra` with the window style
  and has no Dock icon (`LSUIElement`). It shows the tiny card from `docs/design/preview.html` by
  default and expands to the full card on a click, following `DESIGN.md` (tokens, typefaces,
  order of the card, motion timings, "Never color alone"). Source: `docs/research/architecture.md`
  section 7 ("Recommendation: SwiftUI"); `DESIGN.md`, "Layout" and "Motion".
- **Minimum macOS 14 (Sonoma).** `MenuBarExtra` needs macOS 13, the Observation framework
  (`@Observable`) needs macOS 14, and Xcode 26 on GitHub's `macos-26` runner can target any macOS
  from 11 to 26. Apple usually ships security updates for the current macOS and the two before it,
  which in October 2026 are 26, 15 and 14. Design decision 2 explains the choice.
- **A Swift package, not an Xcode project.** `mac/Package.swift` has two library targets (the
  daemon client and the views) and one executable target. `mac/scripts/make-app.sh` wraps the
  executable into `Relay.app` with an `Info.plist` (`LSUIElement`, the `relay` link scheme,
  `LSMinimumSystemVersion` 14.0), signs it ad hoc, and zips it as `Relay-macOS.zip`. A package is
  plain text that reviewers and agents can read, and the app needs nothing that only an Xcode
  project provides (design decision 3).
- **Talks to the daemon only over the Unix socket.** The app opens `$RELAY_HOME/run/relay.sock`
  (default `~/.relay/run/relay.sock`) with a plain Unix-domain socket, sends HTTP/1.1 requests to
  the `/v1` endpoints and follows `GET /v1/events` (server-sent events, resumed with
  `Last-Event-ID`). Before it connects, it checks that the socket folder is private and owned by
  the person; after it connects, it checks with `getpeereid` that the daemon runs as the same
  user. It opens no TCP connection and sends no `Origin` header. Source: `add-daemon-api-and-status`
  (`local-api` spec, design decisions 3, 13 to 16); `docs/research/security.md` section 1,
  "Recommendation", items 1, 3 and 5.
- **It shows state and opens views.** The card shows the job, one status line in words, the
  previous and current worker, the latest checkpoint and the reset time when relay knows it. Its
  primary action brings forward the app that runs the current agent (for example Terminal), found
  from the worker's process ID; "View checkpoint" opens a sheet. Capacity appears only when a
  provider reported it, with what was measured and when (`DESIGN.md`, rule 4, "Honest data").
- **One action, through the same API endpoint as the CLI.** "Switch worker…" sends
  `POST /v1/jobs/{job}/switch`, the endpoint phase 5 built on the phase 4 switch engine. The engine's
  questions reach the person with the engine's own words: the first handoff to a new provider is
  confirmed in the app and sent again with `"confirm_new_provider": true`; any other question, and
  a job whose agents run in a terminal, end with the exact `relay switch` command to run in the
  project. Source: `add-relay-switch` design decision 16; `docs/research/security.md` section 6.
- **`relay://job/<id>` links only open the card of that job.** They never switch, checkpoint or
  start anything. Source: `docs/research/security.md` section 1, "Recommendation", item 4;
  `openspec/config.yaml`, "Local API".
- **Built and tested only on GitHub Actions.** A new workflow, `.github/workflows/mac-app.yml`,
  runs one job on `macos-26` (the image that `macos-latest` points to today). The job runs
  `swift test` against a fake daemon on a temporary Unix socket, renders the tiny and expanded card
  to PNG files with SwiftUI's `ImageRenderer`, builds and zips the app, launches it for five seconds
  as a smoke test, and uploads the screenshots and `Relay-macOS.zip` as workflow artifacts. It runs
  only when `mac/**` or the workflow changes, because macOS minutes cost ten times Linux minutes.
  Nothing is built on Josué's Mac (the private task board, "Pins").
- **Attached to the GitHub Release.** Releases are published by hand with `gh release create`.
  A release tag starts `mac-app.yml`, which builds the app with the tag's version, and
  `mac/scripts/attach-to-release.sh` attaches `Relay-macOS.zip` to the release next to the
  command-line binaries (design decision 15, changed on 2026-10-08).
- **Unsigned.** No Developer ID and no notarization, as decided on 2026-10-07. The bundle carries an
  ad-hoc signature, because macOS on Apple silicon does not run unsigned code at all.
  `docs/mac-app.md` says how to open it the first time: on macOS 14, right-click the app and choose
  Open; on macOS 15 and later, Apple removed that shortcut, so the person opens it once, then
  clicks "Open Anyway" in System Settings, Privacy & Security.
- **Documentation:** `docs/mac-app.md` (install, first launch, what the card shows, how it talks to
  the daemon, its security limits), with a diagram, and one line in `README.md`.

## Out of scope

- Signing with a Developer ID, notarization, a DMG, Sparkle updates and a Homebrew cask. They need
  the Apple Developer Program (`docs/ROADMAP.md`, "Decisions made", 2026-10-07). Phase 8 in the
  roadmap mentions notarization and updates; the later decision not to have an Apple account for
  now wins.
- Starting the daemon from the app, `SMAppService` launch agents and "Open at login". The CLI
  starts the daemon on demand (phase 5); the app tells the person the command to run.
- Any action other than switch: no checkpoint, rollback, run or approval buttons.
- Any TCP listener, token, XPC service or change to the daemon's API. The app uses phase 5's API as
  it is.
- Notifications, the job lineage view, a jobs menu with several jobs, the "Pin" button and the
  "Last tests" row of the preview card (the API exposes no test results in v1).
- Intel Macs. The CLI ships for macOS arm64 only (`add-cli-scaffold` design decision 10), so the app
  is built for arm64 only.
- A sandboxed or Mac App Store build: a sandboxed app cannot reach a socket outside its container
  (`docs/research/security.md` section 1, "Two caveats on sockets").

## Security

- **Local API.** The app is a client of the socket only. It refuses to connect when the runtime
  folder is a symbolic link, is owned by another user or is open to the group or others, and it
  closes a connection whose peer is another user, so another account on the Mac cannot pretend to
  be the daemon. It sends no `Origin` header, follows no redirects, and caps response sizes. As
  `docs/research/security.md` section 1 says, any program running as the same user can use the
  socket; the app does not change that, and `docs/mac-app.md` says so.
- **Credentials.** The app never reads, stores or displays provider credentials, profile folders,
  Keychain items or environment variables of agents. It reads only what the API returns, and the API
  never returns credentials (phase 5 security section).
- **Actions.** The only action is switch, through the same endpoint and engine as `relay switch`.
  The app never sets `confirm_new_provider` without the person's click on a question that shows the
  engine's text, never retries a `POST` by itself, and never answers a question the API cannot
  express.
- **Links.** `relay://` links open or focus a view and nothing else. A link with anything other
  than `job/<8 hexadecimal characters>` is ignored.
- **Git.** The app runs no git command. Checkpoint data comes from the API.
- **Supply chain.** No third-party Swift packages. The workflow pins every action to a full commit
  SHA, keeps the token read-only, and does not persist checkout credentials (`add-cli-scaffold`
  design decision 11; `docs/research/security.md` section 8, recommendation 6). The workflow file
  is under `.github/workflows/**`, a protected path in the private task board: its pull request needs both an
  independent Opus review and `codex review` before merging.

## Capabilities

### New Capabilities

- `mac-app-daemon-client`: finding and checking the socket, the peer check, the HTTP/1.1 subset
  the app sends and accepts, the endpoints it calls, following the event stream (resume, `reset`,
  `shutdown`, reconnecting), and the version and capability check.
- `mac-app-card`: the menu-bar icon, the tiny and the expanded card, which job they show, every
  line of text and when it appears, the states without a daemon or without jobs, the primary action
  and the checkpoint sheet.
- `mac-app-switch`: the "Switch worker…" sheet, the request it sends, and how each answer of the
  switch endpoint reaches the person.
- `mac-app-links`: the `relay://job/<id>` link scheme and the rule that links only open views.
- `mac-app-build`: the Swift package, the app bundle, the minimum macOS version, the CI workflow on
  the macOS runner, the screenshots, the release asset and the first-launch instructions.

### Modified Capabilities

None. The app uses the `local-api` capability of `add-daemon-api-and-status` without changing it.

## Impact

- New folder `mac/`: `Package.swift`, `Sources/RelayKit/` (socket, HTTP, event stream, API models,
  the app's state), `Sources/RelayUI/` (tokens, fonts, cards, sheets), `Sources/Relay/` (the app
  entry, menu-bar scene, link handling), `Tests/`, `Resources/Fonts/` (Public Sans and IBM
  Plex Mono with their licenses), `Support/Info.plist`, `scripts/make-app.sh` and
  `scripts/smoke-test.sh`.
- New workflow `.github/workflows/mac-app.yml` and the script `mac/scripts/attach-to-release.sh`;
  releases are published by hand, with no release workflow.
- New test `test/mac/fixtures-match-daemon.test.ts` (Bun, Linux): it checks the app's JSON fixtures
  against a real phase 5 daemon, so the fixtures cannot drift from the API.
- New documentation `docs/mac-app.md`; one line in `README.md`; `docs/codebase-map.md` gains the
  `mac/` folder when that map exists.
- No change to the daemon, the CLI or the API in this change. Design decision 17 asks phase 5 for
  four additions within `/v1` (a `Relay-Stream-Seq` header on `GET` answers, `reset` for a cursor
  ahead of history, a `stream_epoch`, and a `worker` event when a worker is found gone); until they
  exist, the app orders data, resets its event cursor and refreshes worker liveness with the
  fallbacks in design decision 7. No new dependency.

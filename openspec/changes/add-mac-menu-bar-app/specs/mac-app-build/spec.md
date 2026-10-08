# Spec Delta

## Purpose

The Mac app is built, tested and packaged only on GitHub's macOS runners, never on Josué's Mac. This
capability defines the Swift package, the app bundle, the minimum macOS version, the one CI job,
its artifacts and the release asset.

## ADDED Requirements

### Requirement: Swift package without dependencies
The app SHALL be a Swift package in `mac/` with tools version 6.0, platform macOS 14, the targets `RelayKit`, `RelayUI` and `Relay` (executable), the test-only targets `RelayTestSupport`, `RelayKitTests` and `RelayUITests`, and no package dependencies.

#### Scenario: No dependencies
- **WHEN** `swift package describe --type json` runs in `mac/` on the runner
- **THEN** its `dependencies` list is empty and its platforms list macOS 14.0

### Requirement: App bundle
`mac/scripts/make-app.sh <version> [<build>]` SHALL build `mac/build/Relay.app` for arm64 with the executable `Contents/MacOS/Relay`, the `Info.plist` of design decision 3 (`LSUIElement` true, `LSMinimumSystemVersion` 14.0, the `relay` URL scheme, the given version), the fonts in `Contents/Resources/Fonts`, an ad-hoc signature, and SHALL zip it as `mac/build/Relay-macOS.zip` with `ditto`. It SHALL refuse a version that is not digits separated by dots.

#### Scenario: Bundle checks
- **WHEN** `sh scripts/smoke-test.sh build/Relay.app` runs after the build
- **THEN** `plutil -lint` passes, `LSUIElement` is true, `lipo -archs` prints `arm64` and `codesign --verify --strict` passes

#### Scenario: Bad version
- **WHEN** `sh scripts/make-app.sh v0.8` runs
- **THEN** it exits 2 with "Version must look like 0.8.0, got: v0.8"

### Requirement: The app starts without a daemon
The built app SHALL keep running for at least 5 seconds when started with an empty `RELAY_HOME`.

#### Scenario: Smoke test
- **WHEN** the smoke test starts `Relay.app/Contents/MacOS/Relay` with `RELAY_HOME` set to an empty temporary folder
- **THEN** the process is still alive after 5 seconds and the script prints "Smoke test passed"

### Requirement: One macOS job in CI
`.github/workflows/mac-app.yml` SHALL run one job on `macos-26` with a 20-minute limit, read-only contents permission and checkout without persisted credentials, every action pinned to a full commit SHA, triggered by pull requests and pushes to `main` that change `mac/**` or the workflow, by `workflow_dispatch`, and by `workflow_call` with a `version` input. The job SHALL run `swift test`, build the bundle, run the smoke test, and upload the artifacts `mac-app-screenshots` and `Relay-macOS` for 7 days.

#### Scenario: Unrelated change
- **WHEN** a pull request changes only files under `src/`
- **THEN** no run of the "Mac app" workflow starts

#### Scenario: Results from the Mac
- **WHEN** a run finished on a branch
- **THEN** `gh run view <id> --log` shows the Swift Testing summary line and "Smoke test passed", and `gh run download <id> --name mac-app-screenshots` downloads the PNG files

### Requirement: Screenshots of the cards
When `RELAY_SCREENSHOT_DIR` is set, `swift test` SHALL write PNG files rendered with `ImageRenderer` at scale 2 for the cases `tiny-handoff`, `expanded-handoff`, `expanded-limit-no-worker`, `expanded-usage`, `tiny-not-running`, `expanded-no-jobs` and `switch-confirmation`, each in `-light` and `-dark` versions, and SHALL fail when an image is not twice the view's width or has a single color.

#### Scenario: Fourteen images
- **WHEN** the workflow's test step finishes
- **THEN** the `mac-app-screenshots` artifact holds 14 PNG files, including `tiny-handoff-light.png` 560 pixels wide

### Requirement: Release asset
The release workflow SHALL call `mac-app.yml` with the release version and SHALL attach `Relay-macOS.zip` to the GitHub Release, keeping write permission out of `mac-app.yml`.

#### Scenario: Release
- **WHEN** a release is published for version 0.8.0
- **THEN** `gh release view v0.8.0 --json assets --jq '.assets[].name'` lists `Relay-macOS.zip`, and the app's `CFBundleShortVersionString` is `0.8.0`

### Requirement: First launch is documented
`docs/mac-app.md` SHALL give the install commands with `gh release download`, and SHALL say that the app is not notarized, that on macOS 14 the person right-clicks the app and chooses Open, and that on macOS 15 and later the person opens it once and then clicks "Open Anyway" in System Settings, Privacy & Security.

#### Scenario: Instructions present
- **WHEN** a reader opens `docs/mac-app.md`
- **THEN** it contains the commands `gh release download --repo FrejusGdm/relay --pattern Relay-macOS.zip` and `ditto -x -k`, and both first-launch paths

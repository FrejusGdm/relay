# Spec Delta

## Purpose

Defines the install panel that the "CLI setup" and "Get relay" buttons open: the commands it shows for the command-line tool and the Mac app, its copy buttons, and its text about where the commands download from.

## ADDED Requirements

### Requirement: Opening the panel
The buttons `CLI setup` and `Get relay` SHALL open one panel, `id="install"`, through the Popover API, so that it opens without JavaScript. The panel SHALL close with its `Close` button, with the Escape key and with a click outside it. The `Get relay` buttons in the hero and the closing panel SHALL also move focus to the panel's "Command line on macOS" heading.

#### Scenario: CLI setup from the hero
- **WHEN** a visitor clicks `CLI setup` in the hero
- **THEN** the panel `Install relay` is open and shows the macOS and Linux commands and the Mac app block

#### Scenario: Escape
- **WHEN** the panel is open and the visitor presses Escape
- **THEN** the panel is closed

#### Scenario: Get relay
- **WHEN** a visitor clicks `Get relay` in the hero
- **THEN** the panel is open and the heading `Command line on macOS` has focus and is visible

### Requirement: Open source notice
Josué made relay open source on 2026-10-08, so the install commands download the release directly. The panel SHALL say, before any command, "relay is free and open source. These commands download the latest release from GitHub.", with "open source" linking to `https://github.com/FrejusGdm/relay`. It SHALL NOT ask for a GitHub account or the GitHub CLI.

#### Scenario: Notice text
- **WHEN** the panel is read
- **THEN** its first paragraph is that sentence with that link
- **AND** the page contains none of `gh auth`, `gh release`, `private` and `--pattern`

### Requirement: Command-line install commands
The panel SHALL show one block for macOS on Apple silicon and one for Linux on x64. The macOS block SHALL be exactly these lines:

```
mkdir -p "$HOME/.local/bin"
curl -fsSL -o "$HOME/.local/bin/relay" \
  https://github.com/FrejusGdm/relay/releases/latest/download/relay-darwin-arm64
chmod +x "$HOME/.local/bin/relay"
"$HOME/.local/bin/relay" --version
```

The Linux block SHALL be the same with `relay-linux-x64` in place of `relay-darwin-arm64`. Below them, the panel SHALL say how to add `~/.local/bin` to PATH.

#### Scenario: Exact blocks
- **WHEN** the text of `#install-macos-cmd` and `#install-linux-cmd` is read
- **THEN** each equals its block above, character for character

#### Scenario: Linux block works
- **WHEN** the Linux block is run on Linux x64, with no GitHub account, and the latest release has the asset `relay-linux-x64`
- **THEN** the last line prints `relay` followed by its version and exits with code 0

### Requirement: Mac app install commands
The panel SHALL show a block for the Mac app that is exactly these lines:

```
cd "$HOME/Downloads"
gh release download \
  --repo FrejusGdm/relay \
  --pattern Relay-macOS.zip \
  --clobber
ditto -x -k Relay-macOS.zip /Applications
open /Applications/Relay.app
```

Below it, the panel SHALL say that the Mac app needs the command-line tool, that the app is not signed yet, that it opens normally when downloaded with `gh`, and that after a browser download the visitor opens it with System Settings, Privacy & Security, Open Anyway. The panel SHALL NOT tell the visitor to turn Gatekeeper off. Until a release contains `Relay-macOS.zip`, the Mac app block SHALL show only its heading and the note "The Mac menu-bar app is not released yet. The command line tool above works on its own.", with no command, no Copy button and no first-launch note.

#### Scenario: Mac app not released yet
- **WHEN** no release contains `Relay-macOS.zip` and the Mac app block is read
- **THEN** it contains the "not released yet" note and no command or Copy button

#### Scenario: Mac app block
- **WHEN** a release contains `Relay-macOS.zip` and the text of `#install-mac-cmd` is read
- **THEN** it equals the block above, character for character

#### Scenario: First launch advice
- **WHEN** a release contains `Relay-macOS.zip` and the note under the Mac app block is read
- **THEN** it contains `Open Anyway`
- **AND** the page contains neither `spctl` nor `xattr`

### Requirement: Copy buttons
Each command block SHALL have a `Copy` button that copies the block's text followed by one newline. After copying, the button SHALL read `Copied` for 1.6 seconds, or `Copy failed` when copying failed, and a screen-reader status SHALL announce the result.

#### Scenario: Copy the macOS block
- **WHEN** the visitor clicks `Copy` next to the macOS block
- **THEN** the clipboard holds the macOS block followed by a newline
- **AND** the button reads `Copied`

### Requirement: Readable on a phone
No line of any command block SHALL be longer than 42 characters, except the download address, which cannot be split. At 390 pixels wide every block SHALL show its full width without scrolling sideways; a line that does not fit SHALL wrap, and copying SHALL still give the original lines.

#### Scenario: Phone width
- **WHEN** the panel is open in a 390 pixel wide window
- **THEN** each command block's `scrollWidth` is at most its `clientWidth`
- **AND** the panel lies inside the window horizontally

### Requirement: Asset names agree with the release
The asset names in the panel SHALL be `relay-darwin-arm64` and `relay-linux-x64`, and also `Relay-macOS.zip` once a release contains it; until then the Mac app block shows a "not released yet" note. When `.github/workflows/release.yml` exists, it SHALL contain each name the panel shows.

#### Scenario: Release workflow present
- **WHEN** `.github/workflows/release.yml` exists and `bun test site/test` runs
- **THEN** the test fails if the workflow lacks `relay-darwin-arm64` or `relay-linux-x64`

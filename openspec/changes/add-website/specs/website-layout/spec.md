# Spec Delta

## Purpose

Defines how the website fits the screen: no sideways scrolling at 1440, 1024 and 390 pixels, the spacing between sections, background art that never crosses text, motion that respects reduced motion, and the Playwright checks and screenshots that prove it.

## ADDED Requirements

### Requirement: No sideways scrolling
At window widths of 1440, 1024 and 390 pixels, the page SHALL NOT be wider than the window, both with motion reduced and while the hero story plays. The page SHALL NOT hide overflow on `html` or `body` to pass this check.

#### Scenario: Width check
- **WHEN** Playwright loads the home page at each of the three widths
- **THEN** `document.documentElement.scrollWidth` is at most `document.documentElement.clientWidth`

#### Scenario: During the animation
- **WHEN** the home page is loaded at each width without reduced motion and checked every 500 ms for 8 seconds
- **THEN** the page is never wider than the window

#### Scenario: Overflow hidden on body
- **WHEN** `styles.css` is read
- **THEN** no rule sets `overflow-x` or `overflow` to `hidden` on `html` or `body`

### Requirement: Nothing sticks out or is cut off
At each of the three widths, no visible element SHALL extend sideways past the window, or past an ancestor that clips it in either direction. Content inside a box that scrolls (the terminal example) may be wider than that box, but the box SHALL fit. The only exceptions SHALL be the decorative track maps and, above 520 pixels, the checkpoint document that bleeds out of its cell by design.

#### Scenario: Overflow check
- **WHEN** Playwright runs the overflow check from design decision 8 at 1440, 1024 and 390 pixels with reduced motion
- **THEN** it returns an empty list

### Requirement: Section spacing
Sections SHALL be 128 pixels apart at widths above 1100 pixels, 112 pixels at 1100 pixels and below, and 96 pixels at 860 pixels and below, within the 96 to 144 pixels that `DESIGN.md` sets. The content width SHALL be at most 1200 pixels with 24 pixels of side padding, and 16 pixels at 640 pixels and below.

#### Scenario: Phone width
- **WHEN** the home page is shown at 390 pixels
- **THEN** a section's top padding is 96 pixels and `.wrap` has 16 pixels of padding on each side

### Requirement: Background art never crosses text
Josué asked on 2026-10-08 for the track lines that ran from the hero's text to the card to be removed, so the hero SHALL have no track map. The track lines behind the closing panel SHALL NOT cross any text or button, and at 700 pixels and below they SHALL be hidden.

#### Scenario: Hero without track lines
- **WHEN** the home page is shown at 1440, 1024 or 390 pixels
- **THEN** the hero has no `.map` element and no SVG `line`

### Requirement: Fonts load
The page SHALL render headlines in Satoshi, text in Public Sans and commands in IBM Plex Mono, all loaded from the site.

#### Scenario: Satoshi loaded
- **WHEN** Playwright loads the home page and waits for `document.fonts.ready`
- **THEN** `document.fonts.check('500 40px Satoshi')` is true

### Requirement: Reduced motion
When the visitor's system asks for reduced motion, the hero card SHALL show its final state without animation, as in the preview, and every transition SHALL take at most 1 ms.

#### Scenario: Reduced motion
- **WHEN** the home page is loaded with `prefers-reduced-motion: reduce`
- **THEN** the hero card's Codex row reads `Current worker` and `Working` without playing the story
- **AND** the card's note reads `Illustrated manual handoff · reduced motion`

### Requirement: Screenshots as proof
Each Playwright run SHALL save a full-page screenshot at 1440, 1024 and 390 pixels to `site/e2e/out/<target>-<width>.png`, where `<target>` is `local` for the emulator and `live` for the deployed site. Screenshots SHALL NOT be committed; they are attached to the pull request.

#### Scenario: Local run
- **WHEN** `bun run site:e2e` finishes on the Omarchy machine without `SITE_URL`
- **THEN** `site/e2e/out/` holds `local-1440.png`, `local-1024.png` and `local-390.png`

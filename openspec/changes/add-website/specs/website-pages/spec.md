# Spec Delta

## Purpose

Defines what relay's public website shows: the home page built from the design preview, the pricing section, the links, the theme, the 404 page and what search engines are told.

## ADDED Requirements

### Requirement: Static site from the design preview
The website SHALL be the folder `site/public/`, deployed exactly as it is in the repository, with no build step. Its home page SHALL show, in this order, the navigation and hero with the illustrated handoff card, the providers row, and the sections "Switching agents by hand costs you the afternoon.", "Everything the next agent needs.", "One agent or a hundred.", "relay is free. You already paid for the agents." and "Your agents should be disposable. Your work shouldn’t be.", followed by the footer. Their content SHALL match `docs/design/preview.html` except for the changes listed in this change's design. Josué asked on 2026-10-08 for the preview's "Switch from the terminal." section to be hidden, so the home page SHALL NOT have it.

#### Scenario: Section order
- **WHEN** `site/public/index.html` is read
- **THEN** the section ids appear in the order `cost`, `how`, `graph`, `pricing`, `closing`

#### Scenario: Headline and title
- **WHEN** a visitor opens the home page
- **THEN** the browser tab reads `relay: never run out of limits again`
- **AND** the only `<h1>` reads `Never run out of limits again.`

### Requirement: No preview controls
The website SHALL NOT contain the preview's controls or reference material: no headline, font or accent pickers, no token reference section, no motion demos, and no use of the word "preview" in its text.

#### Scenario: Preview parts removed
- **WHEN** `site/public/index.html` is searched for `preview`, ignoring case
- **THEN** there is no match
- **AND** the page has no element with the class `topbar` or `tokens`

### Requirement: Pricing copy without a checkout
The home page SHALL have a pricing section (`id="pricing"`) that says the core is free and that paid features will come later as a one-time payment for a lifetime license, with no subscription and no share of agent spending. The website SHALL NOT show a price, a plan name, a checkout link, a payment form or any payment provider's code.

#### Scenario: Pricing words
- **WHEN** the pricing section is read
- **THEN** it contains `one-time payment` and `lifetime license`
- **AND** the page contains no `$` followed by a digit, and none of `checkout`, `stripe` or `buy now` in any case

#### Scenario: No forms that submit
- **WHEN** the page is searched for `<form`
- **THEN** every form has `method="dialog"`

### Requirement: Links lead somewhere
Every link on the website SHALL lead to a part of the page or a page that exists. The only link targets SHALL be `#top`, `#how`, `#pricing`, `/`, `https://www.apache.org/licenses/LICENSE-2.0` and, since Josué made relay open source on 2026-10-08, the public repository `https://github.com/FrejusGdm/relay`.

#### Scenario: Link check
- **WHEN** every `href` of an `<a>` element in `index.html` and `404.html` is listed
- **THEN** each one is in the allowed list
- **AND** the only one that contains `github.com` is `https://github.com/FrejusGdm/relay`

### Requirement: Theme button with light by default
Josué asked on 2026-10-08 for one small icon button in place of the Light, Dark and System switch. The navigation SHALL have one theme button that shows a moon icon on the light page and a sun icon on the dark page, with the label `Switch to dark theme` or `Switch to light theme`, a visible focus outline and a size of 32 to 36 pixels. There SHALL be two themes: the light tokens of `DESIGN.md` with the olive accent, which is the default, and the dark tokens with the olive dark accent. `site/public/theme.js`, loaded in `<head>` before the stylesheet, SHALL apply the saved theme before the first paint and SHALL remember the choice in `localStorage` under the key `relay-theme`. When the browser blocks storage, the button SHALL still work for the open page.

#### Scenario: Light by default
- **WHEN** a browser that prefers a dark color scheme opens the home page for the first time
- **THEN** the page background is `#F4F2EC`, the button's label is `Switch to dark theme` and the moon icon shows

#### Scenario: Dark choice survives a reload
- **WHEN** the visitor clicks the theme button and reloads the page
- **THEN** `<html>` has `data-theme="dark"` before `<body>` is created, the page background is `#0D0D0C` and the sun icon shows

#### Scenario: Storage blocked
- **WHEN** the browser throws on every `localStorage` access and the visitor clicks the theme button
- **THEN** the page turns dark with no console error, and after a reload it is light

### Requirement: Get relay in the navigation is the primary button
Josué asked on 2026-10-08 for the navigation's `Get relay` button to use the same olive as the hero's main button. It SHALL have the classes `btn btn-primary btn-sm`.

#### Scenario: Olive in both themes
- **WHEN** the home page is shown in the light theme, then in the dark theme
- **THEN** the navigation's `Get relay` and the hero's `Get relay` both have the background `#52613A`, then both have `#BDCDA0`

### Requirement: No tool logos
Josué decided on 2026-10-08 against tool logos. The providers row SHALL show the tool names as text only.

#### Scenario: Providers row
- **WHEN** `site/public/index.html` is read
- **THEN** the providers row has no `<img>` and no `<svg>`

### Requirement: Not-found page
An address that does not exist SHALL answer with HTTP status 404 and the website's own page, titled `Page not found · relay`, with a link to the home page. The 404 page SHALL load the stylesheet and `theme.js`, so it shows the saved theme, and no other script; it has no theme switch.

#### Scenario: Unknown address
- **WHEN** a visitor opens `/no-such-page`
- **THEN** the response status is 404
- **AND** the page's heading reads `Page not found`

### Requirement: Kept out of search engines until the public release
Until Josué decides on the public release, every response SHALL carry `X-Robots-Tag: noindex, nofollow`, and `robots.txt` SHALL disallow every path.

#### Scenario: robots.txt
- **WHEN** a crawler requests `/robots.txt`
- **THEN** the body is `User-agent: *` and `Disallow: /`

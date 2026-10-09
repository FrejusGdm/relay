# Spec Delta

## Purpose

Replaces the pricing section's promise of later paid features with a short joke price and the plain fact that relay is free and open source, and adds a link to the GitHub repository with its star count.

## MODIFIED Requirements

### Requirement: Static site from the design preview
The website SHALL be the folder `site/public/`, deployed exactly as it is in the repository, with no build step. Its home page SHALL show, in this order, the navigation and hero with the illustrated handoff card, the providers row, and the sections "Switching agents by hand costs you the afternoon.", "Everything the next agent needs.", "One agent or a hundred.", "What relay costs." and "Your agents should be disposable. Your work shouldn’t be.", followed by the footer. Their content SHALL match `docs/design/preview.html` except for the changes listed in `add-website`'s design and in this change. Josué asked on 2026-10-08 for the preview's "Switch from the terminal." section to be hidden, so the home page SHALL NOT have it.

#### Scenario: Section order
- **WHEN** `site/public/index.html` is read
- **THEN** the section ids appear in the order `cost`, `how`, `graph`, `pricing`, `closing`

#### Scenario: Headline and title
- **WHEN** a visitor opens the home page
- **THEN** the browser tab reads `relay: never run out of limits again`
- **AND** the only `<h1>` reads `Never run out of limits again.`

## REMOVED Requirements

### Requirement: Pricing copy without a checkout
**Reason**: It promised paid features as a one-time payment for a lifetime license. relay is free since 2026-10-09, so the promise is wrong.

**Migration**: The requirement "Free pricing note" below replaces it and keeps its rules against a checkout and payment forms.

## ADDED Requirements

### Requirement: Free pricing note
The pricing section (`id="pricing"`) SHALL have the heading "What relay costs." and, below it, one box that shows, in this order: the joke price `$19.99` in the display font, the line `I’m joking.` underlined, the line `relay is free and open source.`, and the line `You already paid for the agents.` It SHALL use only the existing fonts and colour tokens, and it SHALL be readable in the light and the dark theme. `$19.99` SHALL be the only price on the page. The website SHALL NOT have a buy button, a checkout link, a payment form, a license page, an API or any payment provider's code.

#### Scenario: Note text
- **WHEN** the pricing section is read
- **THEN** its paragraphs with a class are, in order, `$19.99`, `I’m joking.` and `relay is free and open source.`
- **AND** `I’m joking.` is drawn with an underline

#### Scenario: Both themes
- **WHEN** a visitor opens the home page in the light theme and then switches to the dark theme
- **THEN** the note is visible in both, and `$19.99` uses the theme's text colour

#### Scenario: Nothing to buy
- **WHEN** the page is searched
- **THEN** the only `$` followed by a digit is `$19.99`
- **AND** none of `checkout`, `stripe`, `buy`, `lifetime`, `license key` or `paid feature` appears, in any case
- **AND** there is no link to `/license` and no address under `/api/`
- **AND** every form has `method="dialog"`

### Requirement: GitHub link with the star count
The navigation SHALL have a link to `https://github.com/FrejusGdm/relay` between the theme button and "Get relay". It SHALL show the GitHub mark (`mark-github-16` from Octicons, MIT License, credited in a comment beside it) and the repository's star count, written as the number up to 999 and as thousands above it (`1.2k`, `26k`). `site/public/github.js` SHALL read the count from `https://api.github.com/repos/FrejusGdm/relay` (`stargazers_count`) without cookies or referrer, and SHALL keep it for one hour in the `localStorage` entry `relay-github-stars`. The count's width SHALL be kept free from the start, so the navigation does not move when it arrives. When the request fails or the repository is private, the link SHALL show no number and nothing SHALL be saved. The link's accessible name SHALL be "relay on GitHub", followed by ", <count> stars" once the count is known. Below 641 pixels the link SHALL show the mark only. It SHALL use only the existing fonts and colour tokens, work in both themes, and show the site's focus outline.

#### Scenario: Count shown
- **WHEN** GitHub answers with `stargazers_count` 1234
- **THEN** the link shows `1.2k` and its accessible name is `relay on GitHub, 1.2k stars`

#### Scenario: Request fails or repository is private
- **WHEN** GitHub answers 404 or the request fails
- **THEN** the link is shown without a number, its accessible name is `relay on GitHub`, and `relay-github-stars` is not saved

#### Scenario: Count kept for an hour
- **WHEN** the page is opened again within an hour
- **THEN** it shows the saved count without asking GitHub, and after an hour it asks again

#### Scenario: No shift
- **WHEN** the count arrives after the page is drawn
- **THEN** the "Get relay" button does not move

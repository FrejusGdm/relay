# Spec Delta

## Purpose

Defines what the website may load and send: its Content-Security-Policy and other headers, self-hosted fonts, and the rules against telemetry, third-party code, cookies and browser storage.

## ADDED Requirements

### Requirement: Content-Security-Policy and security headers
Every response of the website SHALL carry these headers, set in `site/public/staticwebapp.config.json` under `globalHeaders`:

- `Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`
- `Strict-Transport-Security: max-age=63072000; includeSubDomains`
- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: DENY`
- `Referrer-Policy: no-referrer`
- `Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=()`
- `Cross-Origin-Opener-Policy: same-origin`
- `Cross-Origin-Resource-Policy: same-origin`

#### Scenario: Headers on the home page
- **WHEN** the home page is requested from a running copy of the website
- **THEN** the response has the Content-Security-Policy above, character for character, and `X-Content-Type-Options: nosniff` and `X-Frame-Options: DENY`

#### Scenario: No violations in a browser
- **WHEN** Playwright loads the home page at 1440, 1024 and 390 pixels, opens the install panel, copies a block and opens and closes a card dialog
- **THEN** the browser reports no Content-Security-Policy violation and no console error

### Requirement: Only the site's own files
The website SHALL load scripts, styles, fonts and images only from its own address. It SHALL have no inline script, no `<style>` element, no `style` attribute and no event-handler attribute such as `onclick`. It SHALL NOT include any third-party script, tracker, analytics, advertising or embedded content.

#### Scenario: File check
- **WHEN** `bun test site/test` reads `index.html`, `404.html` and `styles.css`
- **THEN** every `src` and `<link href>` starts with `/` and not `//`, there is no `@import` and, outside comments, no `http` address in `styles.css`, and there is no `style` attribute, inline script or event-handler attribute

### Requirement: No telemetry, cookies or browser storage
The website SHALL NOT set cookies, SHALL NOT use `sessionStorage`, IndexedDB or `document.cookie`, and its scripts SHALL NOT make network requests (`fetch`, `XMLHttpRequest`, `navigator.sendBeacon`, `WebSocket`, `EventSource`). The only browser storage SHALL be the theme choice: `theme.js` SHALL read and write one `localStorage` entry, `relay-theme`, each call inside a `try` block. `site.js` SHALL NOT use `localStorage`.

#### Scenario: Script check
- **WHEN** `bun test site/test` reads `site/public/site.js`
- **THEN** it contains none of `localStorage`, `sessionStorage`, `indexedDB`, `document.cookie`, `fetch(`, `XMLHttpRequest`, `sendBeacon`, `WebSocket`, `EventSource`, `eval(` and `new Function`

#### Scenario: Theme script check
- **WHEN** `bun test site/test` reads `site/public/theme.js`
- **THEN** outside comments it contains none of `sessionStorage`, `indexedDB`, `document.cookie`, `fetch(`, `XMLHttpRequest`, `sendBeacon`, `WebSocket`, `EventSource`, `eval(`, `new Function`, `style` and `http`
- **AND** its only storage calls are one `localStorage.getItem(` and one `localStorage.setItem(`, each directly inside a `try` block, with the key `relay-theme`

#### Scenario: No cookie from the server
- **WHEN** the smoke test requests the home page of the live website
- **THEN** the response has no `Set-Cookie` header

### Requirement: Self-hosted fonts checked by hash
The website SHALL serve Satoshi, Public Sans and IBM Plex Mono from `/fonts/`. `site/scripts/fetch-fonts.sh` SHALL download them from their official sources (Fontshare for Satoshi, the GitHub releases `uswds/public-sans` v2.001 and `IBM/plex` `@ibm/plex-mono@2.5.0`) and SHALL copy them into `site/public/fonts/` only when each file's SHA-256 matches `site/fonts.sha256`. Font files SHALL NOT be committed; Satoshi's license does not allow distributing it through a repository.

#### Scenario: Matching hashes
- **WHEN** `sh site/scripts/fetch-fonts.sh` runs on the Omarchy machine
- **THEN** `sha256sum` reports `OK` for the six files and they are in `site/public/fonts/`

#### Scenario: Changed upstream file
- **WHEN** one hash in `site/fonts.sha256` does not match the downloaded file
- **THEN** the script exits with a non-zero code and copies no file

#### Scenario: Not committed
- **WHEN** the fonts have been downloaded and `git status --short` runs
- **THEN** no file under `site/public/fonts/` is listed

### Requirement: Built-in sign-in turned off
Requests to any path under `/.auth/` SHALL answer with HTTP status 404, because the website has no sign-in.

#### Scenario: GitHub sign-in route
- **WHEN** `/.auth/login/github` is requested
- **THEN** the response status is 404

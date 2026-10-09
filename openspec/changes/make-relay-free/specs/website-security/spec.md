# Spec Delta

## Purpose

Lets the website ask GitHub's public API for the repository's star count, and keep the answer for an hour.

## MODIFIED Requirements

### Requirement: Content-Security-Policy and security headers
Every response of the website SHALL carry these headers, set in `site/public/staticwebapp.config.json` under `globalHeaders`:

- `Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src https://api.github.com; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`
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

### Requirement: No telemetry, cookies or browser storage
The website SHALL NOT set cookies and SHALL NOT use `sessionStorage`, IndexedDB or `document.cookie`. Its scripts SHALL NOT make network requests (`fetch`, `XMLHttpRequest`, `navigator.sendBeacon`, `WebSocket`, `EventSource`), with one exception: `github.js` SHALL make one `fetch` to `https://api.github.com/repos/FrejusGdm/relay`, with `credentials: "omit"` and `referrerPolicy: "no-referrer"`, at most once an hour. The browser storage SHALL be two `localStorage` entries, each read and written inside a `try` block: `relay-theme` in `theme.js` and `relay-github-stars` in `github.js`. `site.js` SHALL NOT use `localStorage` or `fetch`.

#### Scenario: Script check
- **WHEN** `bun test site/test` reads `site/public/site.js`
- **THEN** it contains none of `localStorage`, `sessionStorage`, `indexedDB`, `document.cookie`, `fetch(`, `XMLHttpRequest`, `sendBeacon`, `WebSocket`, `EventSource`, `eval(` and `new Function`

#### Scenario: Theme script check
- **WHEN** `bun test site/test` reads `site/public/theme.js`
- **THEN** outside comments it contains none of `sessionStorage`, `indexedDB`, `document.cookie`, `fetch(`, `XMLHttpRequest`, `sendBeacon`, `WebSocket`, `EventSource`, `eval(`, `new Function`, `style` and `http`
- **AND** its only storage calls are one `localStorage.getItem(` and one `localStorage.setItem(`, each directly inside a `try` block, with the key `relay-theme`

#### Scenario: GitHub script check
- **WHEN** `bun test site/test` reads `site/public/github.js`
- **THEN** its only address is `https://api.github.com/repos/FrejusGdm/relay`, its only `fetch` omits cookies and referrer, and its only storage calls are one `localStorage.getItem(` and one `localStorage.setItem(` inside `try` blocks, with the key `relay-github-stars`

#### Scenario: No cookie from the server
- **WHEN** the smoke test requests the home page of the live website
- **THEN** the response has no `Set-Cookie` header

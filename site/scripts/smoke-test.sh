#!/bin/sh
# Checks a running copy of the website. Usage: sh site/scripts/smoke-test.sh <base address>
set -eu
url=${1:?usage: smoke-test.sh <base address, for example https://example.azurestaticapps.net>}
url=${url%/}
csp="default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; base-uri 'none'; form-action 'self' https://checkout.stripe.com; frame-ancestors 'none'"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
fail() { echo "Smoke test failed: $1" >&2; exit 1; }
# Prints the value of one response header of the home page, without the carriage return.
header() { tr -d '\r' < "$work/headers" | grep -i "^$1:" | head -n 1 | sed 's/^[^:]*:[[:space:]]*//'; }

code=$(curl -sS -o "$work/index.html" -D "$work/headers" -w '%{http_code}' "$url/") || fail "the request to $url/ failed"
[ "$code" = 200 ] || fail "GET / returned $code, expected 200"
grep -qF '<title>relay: never run out of limits again</title>' "$work/index.html" || fail "the page title is missing"
for text in 'curl -fsSL -o "$HOME/.local/bin/relay"' 'https://github.com/FrejusGdm/relay/releases/latest/download/relay-darwin-arm64' 'https://github.com/FrejusGdm/relay/releases/latest/download/relay-linux-x64'; do
  grep -qF -- "$text" "$work/index.html" || fail "the page does not contain: $text"
done
[ "$(header content-security-policy)" = "$csp" ] || fail "the Content-Security-Policy header is missing or different"
[ "$(header x-content-type-options)" = "nosniff" ] || fail "X-Content-Type-Options is missing or different"
[ "$(header x-frame-options)" = "DENY" ] || fail "X-Frame-Options is missing or different"
[ "$(header x-robots-tag)" = "noindex, nofollow" ] || fail "X-Robots-Tag is missing or different"
[ -z "$(header set-cookie)" ] || fail "the response sets a cookie"
font=$(curl -sS -o /dev/null -w '%{http_code} %{content_type}' "$url/fonts/Satoshi-Variable.woff2") || fail "the font request failed"
[ "$font" = "200 font/woff2" ] || fail "the Satoshi font returned: $font"
auth=$(curl -sS -o /dev/null -w '%{http_code}' "$url/.auth/login/github") || fail "the /.auth request failed"
[ "$auth" = 404 ] || fail "/.auth/login/github returned $auth, expected 404"
missing=$(curl -sS -o "$work/404.html" -w '%{http_code}' "$url/no-such-page") || fail "the /no-such-page request failed"
[ "$missing" = 404 ] || fail "/no-such-page returned $missing, expected 404"
grep -qF 'Page not found' "$work/404.html" || fail "the 404 page text is missing"
# The license page carries the session ID in its address, so it is never cached or sent as a referrer.
curl -sS -o /dev/null -D "$work/headers" "$url/license/" || fail "the /license/ request failed"
[ "$(header cache-control)" = "no-store" ] || fail "/license/ is missing Cache-Control: no-store"
[ "$(header referrer-policy)" = "no-referrer" ] || fail "/license/ is missing Referrer-Policy: no-referrer"
echo "Smoke test passed: $url"

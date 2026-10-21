# SSRF Security Report

## Status: PASS

## Findings

The server never fetches URLs: `grep -rn "fetch(|http.get|https.get|undici|axios" server shared` → no hits. There are no link previews, image proxies, webhooks or import-from-URL features. External images/links in notes are handled by the browser only (and external images are blocked by CSP `img-src`, see XSS-1). WebAuthn uses no attestation fetching (`attestationType: 'none'`).

## What's at risk

Nothing.

## What's already secure

No server-side outbound requests at all.

## Recommendations

If a link-preview or "import from URL" feature is ever added, apply the AGENTS.md SSRF rules (scheme allowlist, resolve-then-check private ranges, no redirects to private IPs).

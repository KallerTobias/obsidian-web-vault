# Security Headers Security Report

## Status: PASS (Info notes only)

## Findings

Headers are set by one global `@fastify/helmet` registration (`server/http/app.ts:121-138`) and therefore also apply to the static SPA files served by `@fastify/static` and to the SPA fallback. Local scan (`check.py --local`) and `curl -sI` against a local build:

```
Content-Security-Policy: default-src 'self';script-src 'self';style-src 'self' 'unsafe-inline';img-src 'self' data: blob:;connect-src 'self';frame-ancestors 'none';object-src 'none';base-uri 'self';form-action 'self'
Strict-Transport-Security: max-age=31536000; includeSubDomains
X-Frame-Options: SAMEORIGIN
X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Resource-Policy: same-origin
```

CSP directive check: `default-src 'self'` ✓, `script-src 'self'` (no inline/eval; Vite build without module-preload polyfill, `assetsInlineLimit: 0`) ✓, `object-src 'none'` ✓, `base-uri`, `form-action`, `frame-ancestors` explicit ✓, `connect-src 'self'` ✓, `style-src 'unsafe-inline'` (tolerated; Mermaid/KaTeX/Svelte). HSTS `max-age=31536000; includeSubDomains` ✓ (`preload` optional — only if every subdomain of the domain is HTTPS-only).

Per-response overrides in `server/http/routes/files.ts:238-242`:
- SVG: `Content-Security-Policy: sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:` ✓
- PDF: `Content-Security-Policy: frame-ancestors 'self'` (deliberate exception). This *replaces* the global CSP for PDF responses; acceptable because a PDF is never parsed as HTML (`nosniff`, fixed `application/pdf` type) — the exception holds.

### HDR-1 (Info): `X-Frame-Options: SAMEORIGIN` instead of `DENY`

Helmet's default. It is needed for the PDF exception (PDFs are framed by the app), and for every other response CSP `frame-ancestors 'none'` takes precedence in all current browsers. No change needed; optionally set `DENY` globally and `SAMEORIGIN` only on PDF responses for old browsers.

### HDR-2 (Info): no `Permissions-Policy`

Not required. Optionally add `Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=()` (keep `publickey-credentials-get/create` allowed, which is the default for same origin).

### Local-scan limitations

HSTS was not checked by the scanner on localhost (it is present in the header though); headers added or stripped by the real reverse proxy / Cloudflare cannot be seen locally. Re-run `check.py https://<PUBLIC_URL>` after deployment.

## What's at risk

Nothing concrete.

## What's already secure

All five baseline headers on every response including static assets and errors; strict CSP without inline script; nosniff + sandbox on user files.

## Recommendations

1. After deployment, run the live scan against the public URL and confirm the proxy does not drop or duplicate headers.
2. Optional: HDR-1/HDR-2 hardening.

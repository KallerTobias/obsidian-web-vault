# CORS Security Report

## Status: PASS

## Findings

- No CORS plugin or `Access-Control-*` header is set anywhere in the code (`grep -rn "access-control\|@fastify/cors" server` → none). Same-origin only by design; the SPA and API share one origin.
- Local scan: page and static asset do not allow foreign origins. Helmet adds `Cross-Origin-Resource-Policy: same-origin` and `Cross-Origin-Opener-Policy: same-origin`.
- Unsafe methods additionally require `Origin == PUBLIC_URL` (see CSRF report).

Local-scan limitation: a CDN/proxy in front (e.g. Cloudflare) could add CORS headers; re-check with the live scan after deployment.

## What's at risk

Nothing.

## What's already secure

No CORS surface.

## Recommendations

Re-run the live scan against the deployed URL.

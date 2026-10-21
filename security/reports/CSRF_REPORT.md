# CSRF Security Report

## Status: LOW

## Findings

- Only one auth cookie exists: `vw_session` with `HttpOnly; Secure; SameSite=Strict; Path=/` (`server/http/guards.ts:204-218`), Max-Age renewed on every authenticated request. No refresh-token cookie, no other cookies.
- Global `onRequest` hook `requireSameOrigin` (`server/http/guards.ts:239-246`, registered `app.ts:149`) rejects every POST/PUT/PATCH/DELETE whose `Origin` is not exactly the `PUBLIC_URL` origin — including the unauthenticated login/setup routes and requests without an `Origin` header. Verified locally: foreign `Origin` → 403, missing `Origin` → 403.
- No GET route changes state. `GET /api/auth/state` and `GET /api/events` only read; the only GET-side write is the session's sliding expiry, which is not attacker-useful.
- Setup token travels in the URL fragment (`server/cli.ts:489-492`) and in the POST body, never in a GET query.

### CSRF-1 (Low): cookie name has no `__Host-` prefix

- `server/http/guards.ts:202`. With `__Host-vw_session` the browser guarantees the cookie was set by this exact host over HTTPS with `Path=/` and no `Domain`, so a sibling subdomain (or an attacker controlling one, e.g. another service on `*.kaller.me`) cannot plant or shadow the session cookie (cookie tossing / session fixation). Note: on `http://localhost` dev the prefix also requires `Secure`, which browsers accept on localhost.

## What's at risk

- Practically nothing via classic CSRF: Strict cookie + exact Origin check is defense in depth. CSRF-1 only matters if another subdomain of the deployment domain is ever compromised.

## What's already secure

- `SameSite=Strict` (stricter than the Lax baseline, deliberate exception) plus Origin check on every unsafe method — the stated mitigation holds in code.
- `HttpOnly` and `Secure` on the session cookie, cleared with identical attributes.
- No CORS headers, so cross-origin `fetch` with credentials cannot read responses.

## Recommendations

1. Rename the cookie to `__Host-vw_session` (and accept the old name once for migration, or just force re-login).

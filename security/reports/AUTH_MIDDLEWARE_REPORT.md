# Auth Middleware Security Report

## Status: LOW

## Findings

### How authentication works

- Single user, passkey-only (WebAuthn via `@simplewebauthn/server`). A successful ceremony creates a 256-bit random session token (`server/auth/token-hash.ts:4`), stored server-side only as SHA-256 (`server/auth/sessions.ts:261-279`), sent as cookie `vw_session` (`HttpOnly; Secure; SameSite=Strict; Path=/`, `server/http/guards.ts:204-218`), sliding expiry `SESSION_DAYS` (default 14).
- **Default deny** in a global `onRequest` hook (`server/http/app.ts:61-65, 150-153`): every URL under `/api` needs a session except `/api/health` and `/api/auth/*`. It is decided on the matched route pattern (`req.routeOptions.url`), so encoded URLs cannot dodge it; unknown `/api/*` URLs also get 401 (verified: `/api`, `/api/foo` → 401).
- `/api/auth/*` management routes use `requireSession` as `preHandler` (`server/http/routes/auth.ts:55`). Runs before the handler.

### Route inventory (all verified in code; unauthenticated probes against a local instance returned 401 for every protected route)

| Method | Route | Protection |
|---|---|---|
| GET | `/api/health` | public (returns `{ok:true}`) |
| GET | `/api/auth/state` | public (`authenticated`, `setupRequired` booleans only) |
| POST | `/api/auth/setup/options` | public + setup token + rate limit + Origin |
| POST | `/api/auth/setup/verify` | public + setup token (consumed after verification) + rate limit + Origin |
| POST | `/api/auth/login/options` | public + rate limit + Origin |
| POST | `/api/auth/login/verify` | public + rate limit + Origin, WebAuthn assertion |
| POST | `/api/auth/logout` | Origin; revokes the session if valid |
| GET | `/api/auth/passkeys` | session (preHandler) |
| POST | `/api/auth/passkeys/options`, `/api/auth/passkeys` | session + Origin |
| PATCH/DELETE | `/api/auth/passkeys/:id` | session + Origin |
| GET | `/api/auth/sessions` | session |
| DELETE | `/api/auth/sessions/:id`, POST `/api/auth/sessions/revoke-others` | session + Origin |
| GET | `/api/tree`, `/api/note`, `/api/file`, `/api/rename/affected`, `/api/backlinks`, `/api/meta`, `/api/resolve`, `/api/lookup`, `/api/search`, `/api/tags`, `/api/graph`, `/api/changes`, `/api/events`, `/api/settings` | session (global hook) |
| PUT/POST | `/api/note`, POST `/api/folder`, `/api/rename`, `/api/attachment`, DELETE `/api/entry`, PUT `/api/settings` | session (global hook) + Origin |
| GET | static SPA files, SPA fallback | public (build output only, no data) |

No admin role exists (single user), so the admin-route check is not applicable.

### AUTH-1 (Low): passkey management needs only a session, no fresh user verification

- `server/http/routes/auth.ts:145-172`: with any valid session cookie a client can register an additional passkey, rename passkeys, and delete passkeys (the last one with `?force=1`). Removing a passkey does not revoke sessions created with it (`server/auth/passkeys.ts:298-312`; sessions do not record which passkey created them).
- Consequence: a stolen session (14-day sliding lifetime) can be turned into permanent access by adding the attacker's own passkey, and can lock the owner out by deleting theirs. The spec (`docs/superpowers/specs/2026-10-19-vault-web-design.md:105`) deliberately allows "weitere Passkeys nur aus einer angemeldeten Sitzung heraus", so this is hardening, not a flaw in the stated design. Stealing the session is itself hard (HttpOnly, Strict, strong CSP, sanitized rendering).

### AUTH-2 (Low): user verification is not required

- `server/auth/passkeys.ts:63, 75` (`requireUserVerification: false`), options use `userVerification: 'preferred'` (`:201, :260`). An authenticator that only proves presence (e.g. a hardware key without PIN) is accepted, so the passkey is a single possession factor. With Proton Pass / platform passkeys UV normally happens anyway. Requiring UV may break some hardware keys; it is a trade-off to decide.

### AUTH-3 (Info): first setup link is written to the container log

- `server/cli.ts:507-508` prints `<PUBLIC_URL>/setup#<token>` on `serve` while no passkey exists. This is the documented design (spec line 104). Token is 256 bit, valid 60 min, single use, only consumed after a verified registration, and only one token is open at a time. Anyone who can read `docker logs` during that hour can register the first passkey; keep log access restricted until setup is done.

## What's at risk

- With a stolen session: persistent account takeover via a new passkey (AUTH-1).
- With a stolen PIN-less security key: login (AUTH-2).

## What's already secure

- Global default-deny hook before any handler, decided on the route pattern; 401 on all unauthenticated API access, including unknown `/api/*` paths.
- Session tokens: 256-bit, hashed at rest (`sessions.json` mode 0600), constant-time compare, sliding expiry, pruning, revocation per session and "revoke others"; SSE streams re-check the session on every heartbeat and close when it is revoked (`server/http/routes/events.ts:150-158`).
- WebAuthn: single-use, typed, 5-min challenges; expected origin and RP ID pinned to `PUBLIC_URL`; credential counter updated; duplicate credential rejected; setup token checked before options and again (atomically consumed) after verification.
- `PUBLIC_URL` must be https (http only for localhost) (`server/config.ts:381-384`).
- CLI recovery (`reset-passkeys`) requires host/container access and wipes all sessions.

## Recommendations

1. (AUTH-1) Require a fresh passkey assertion (e.g. within the last 5 minutes, stored as `verifiedAt` on the session) for adding/removing passkeys and for `revoke-others`; record the passkey id on each session and revoke its sessions when that passkey is removed.
2. (AUTH-2) Decide explicitly whether UV is required; if yes, set `requireUserVerification: true` and `userVerification: 'required'`; document the decision in AGENTS.md either way.
3. (AUTH-3) Mention in the README that `docker logs` access equals setup access until the first passkey exists.

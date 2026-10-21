# Rate Limiting Security Report

## Status: MEDIUM

## Findings

### RL-1 (Medium): `CF-Connecting-IP` is trusted from any trusted proxy, so the rate-limit key is spoofable behind Caddy/nginx/Traefik

- `server/http/guards.ts:231-237` (`clientIp`): when `TRUST_PROXY` is set to anything truthy, a non-empty `CF-Connecting-IP` request header wins over `req.ip`.
- `server/http/app.ts:143-147`: this value is the `@fastify/rate-limit` key; `server/http/routes/auth.ts:14` limits setup/login to 10 per minute per key.
- The README's own proxy examples (`README.md:86-127`, Caddy, nginx, Traefik) together with the recommended `TRUST_PROXY=1` do **not** strip `CF-Connecting-IP`. The README (`README.md:85`) asks the operator to strip it, but none of the examples do it, and none of those proxies strip it by default.
- Result: in that setup a client sends `CF-Connecting-IP: <random>` on every request, gets a fresh bucket each time and bypasses the login rate limit completely. The stored session IP (`auth.ts:61`, shown in the session list) is also attacker-controlled.

Why it matters even though passkeys can't be brute-forced:

- `server/auth/passkeys.ts:108-110, 325-336`: open WebAuthn challenges live in one global in-memory map capped at `MAX_CHALLENGES = 1000`; when full, the **oldest are evicted**. `POST /api/auth/login/options` is unauthenticated. An attacker who can create >1000 challenges within the few seconds the owner needs for the passkey prompt evicts the owner's challenge, and every login ends in "Anfrage abgelaufen oder ungültig". With the spoofable key this is one script; the rate limit is the only thing that stops it. That is a login denial of service against the only user of an internet-exposed app.
- Without spoofing (correct proxy, or `TRUST_PROXY=false`) the same eviction needs ~600 distinct IPs per minute, so the challenge-cap design is a residual Low risk on its own.

Verified locally (`TRUST_PROXY` unset): 12 requests with different `X-Forwarded-For` values → `200 x10, 429 x2`, so XFF spoofing is correctly ignored when no proxy is trusted.

### RL-2 (Low): authenticated endpoints have no rate or concurrency limits

- `POST /api/attachment` (`server/http/routes/files.ts:262-307`) buffers up to 50 MB per request in memory (`part.toBuffer()`), `PUT/POST /api/note` accept 10 MB bodies, `GET /api/events` (SSE) connections are unlimited. Only an authenticated user (= the owner or a stolen session) can use them, so this is resource-exhaustion hardening, not an access issue.

## What's at risk

- RL-1: an anonymous attacker can lock the owner out of logging in for as long as the attack runs (no data access). Session-list IPs can be faked.
- RL-2: a stolen session could exhaust memory; the owner's own client cannot.

## What's already secure

- Login and setup ceremony routes (`/api/auth/setup/*`, `/api/auth/login/*`) are rate-limited per IP (10/min); 429 returns a generic message.
- `X-Forwarded-For` is ignored unless `TRUST_PROXY` is set; hop count/CIDR forms are supported (`app.ts:79-82`).
- Setup tokens are 256-bit, compared in constant time and only consumed after a verified passkey (`setup-token.ts`, `token-hash.ts`); session tokens are 256-bit and stored as SHA-256.
- Challenges are single use, typed (registration vs authentication) and expire after 5 min.

## Recommendations

1. Only honour `CF-Connecting-IP` behind an explicit opt-in (e.g. `TRUST_PROXY_HEADER=cf-connecting-ip` or `TRUST_CLOUDFLARE=true`); default to `req.ip` (XFF via the trust function). Mention it in the Cloudflare Tunnel section of the README.
2. Make challenge eviction unable to hit a real user: per-IP cap on open challenges (e.g. 5) and/or bind the challenge to a short-lived HttpOnly cookie instead of a global FIFO; evict per IP rather than globally.
3. Optional: a global (not per-IP) ceiling on `login/options` (e.g. 60/min) as a backstop.
4. Optional (RL-2): per-session rate limit on uploads and a cap on concurrent SSE streams per session.

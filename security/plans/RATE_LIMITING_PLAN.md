# Rate Limiting Fix Plan

## Changes

- `server/config.ts` — new env var (e.g. `TRUST_CF_CONNECTING_IP`, boolean, default `false`) parsed into `Config`.
- `server/http/guards.ts` — `clientIp` reads `CF-Connecting-IP` only when that flag is true **and** the proxy is trusted; otherwise `req.ip`.
- `server/auth/passkeys.ts` — `remember()` takes the client key; keep at most N (e.g. 5) open challenges per key and evict that key's oldest instead of the global oldest. Keep a global cap as a memory bound but make it large (e.g. 10 000) and evict expired first.
- `server/http/routes/auth.ts` — pass `clientIp(req, …)` to `registrationOptions`/`authenticationOptions`; optionally add a global limit for `login/options`.
- `README.md` — Cloudflare section: set the new flag; Caddy/nginx/Traefik sections: leave it off. Document the env var in the table.
- (optional) `server/http/routes/files.ts` / `events.ts` — per-session limits for uploads and open SSE streams.

## New files

- Tests in `tests/server/auth-routes.test.ts` (or a new `rate-limit.test.ts`).

## Verification goals

- [ ] With `TRUST_PROXY=1` and the flag off, 11 `login/options` requests with different `CF-Connecting-IP` values from the same peer → the 11th is 429.
- [ ] With the flag on, `CF-Connecting-IP` determines the key (Cloudflare Tunnel still works).
- [ ] Creating 2000 challenges from one key never evicts a challenge created by another key; a login with a challenge from a second key still verifies.
- [ ] `X-Forwarded-For` spoofing with `TRUST_PROXY` unset still yields 429 after 10 requests.
- [ ] Existing auth tests pass.

## Manual verification (for the human)

- After deploying behind the real proxy, run 12 `curl -X POST -H 'Origin: <PUBLIC_URL>' -H 'CF-Connecting-IP: 1.2.3.<n>' <PUBLIC_URL>/api/auth/login/options` with varying n and confirm the last two are 429 (unless the deployment is Cloudflare Tunnel with the flag on).

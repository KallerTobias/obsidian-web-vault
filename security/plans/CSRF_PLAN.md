# CSRF Fix Plan

## Changes

- `server/http/guards.ts` — `SESSION_COOKIE = '__Host-vw_session'`; keep options (`Secure`, `Path=/`, no `Domain`).
- Tests / e2e that reference the cookie name (`tests/server/*`, `e2e/*`) — update.
- Optional: on login, clear the old `vw_session` cookie.

## New files

None.

## Verification goals

- [ ] Login sets `Set-Cookie: __Host-vw_session=…; Max-Age=…; Path=/; HttpOnly; Secure; SameSite=Strict` without `Domain`.
- [ ] A cross-origin POST (foreign or missing `Origin`) to any state-changing route still returns 403.
- [ ] All tests pass.

## Manual verification (for the human)

- After deploying, log in and check DevTools → Application → Cookies: only `__Host-vw_session`, flags HttpOnly/Secure/Strict.

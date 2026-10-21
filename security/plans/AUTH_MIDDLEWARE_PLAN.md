# Auth Middleware Fix Plan

## Changes

- `server/auth/sessions.ts` — store `passkeyId` and `verifiedAt` per session; `create()` takes the passkey id; new `markVerified(id)`; new `revokeByPasskey(passkeyId)`.
- `server/auth/passkeys.ts` — `finishAuthentication` returns the passkey id instead of `true`; `finishRegistration` result id is used for the setup session.
- `server/http/routes/auth.ts` — new step-up flow (`POST /api/auth/reauth/options|verify`, same rate limit) that sets `verifiedAt`; a `requireRecentVerification(5 min)` preHandler on `POST /api/auth/passkeys/options`, `POST /api/auth/passkeys`, `DELETE /api/auth/passkeys/:id`, `POST /api/auth/sessions/revoke-others`; on passkey delete call `revokeByPasskey`.
- `web/src/components/PasskeyList.svelte` (+ `web/src/lib/passkey.ts`, `api.ts`) — on 403 "re-auth required" run the step-up ceremony and retry.
- (decision) `server/auth/passkeys.ts:63,75,201,260` — UV required or not; document in `AGENTS.md` "Project-specific exceptions".
- `README.md` — note about log access during first setup.

## New files

- Tests for the step-up guard and session revocation by passkey.

## Verification goals

- [ ] Adding or deleting a passkey with a session older than 5 minutes without step-up returns 403 with a re-auth error.
- [ ] After a successful step-up the same request succeeds.
- [ ] Deleting a passkey revokes every session created with it (their next API call returns 401).
- [ ] All existing auth and e2e tests pass; unauthenticated probes still return 401.

## Manual verification (for the human)

- In the browser: Settings → add a passkey after a long-lived session → the passkey prompt appears first, then registration works.
- Delete a second passkey on another device's session and confirm that device is logged out.

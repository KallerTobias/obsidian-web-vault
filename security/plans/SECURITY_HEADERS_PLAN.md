# Security Headers Fix Plan

## Changes

- (optional) `server/http/app.ts` — helmet `frameguard: { action: 'deny' }`; `server/http/routes/files.ts` — on PDF responses also send `X-Frame-Options: SAMEORIGIN`.
- (optional) `server/http/app.ts` — `onSend`/helmet option adding `Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=()`.

## New files

None.

## Verification goals

- [ ] `curl -sI <url>/` shows all headers listed in the report, plus the optional ones if implemented.
- [ ] PDFs still render embedded in notes and in the media view.
- [ ] `check.py <PUBLIC_URL>` against the deployed app: 0 FAIL in SECURITY_HEADERS (including HSTS).

## Manual verification (for the human)

- After deployment: `python3 -I .claude/skills/vibe-check/scripts/check.py https://<PUBLIC_URL>` and compare with the local result in `AUDIT_SUMMARY.md`.

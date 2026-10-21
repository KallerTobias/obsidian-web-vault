# Security Audit Summary

> **Status:** This report describes the state *before* the fixes. All Medium and Low findings below were addressed afterwards (step-up before adding passkeys, required user verification, `__Host-` session cookie, `CF-Connecting-IP` only with `TRUST_CF_CONNECTING_IP`, per-client challenge limit, streamed uploads, stream limits, `npm audit` in CI, `.env` in `.gitignore`). The project was renamed from its working name `vault-web` to `obsidian-web-vault`.

Date: 2026-10-21 · Branch `beta` (HEAD `6ff91bd`) · Method: vibe-check (existing tools + code audit of all 17 categories, plus one local scan)

vault-web: single-user, internet-exposed Node 22/Fastify + Svelte 5 editor for an Obsidian vault, passkey-only login. The deliberate exceptions in `AGENTS.md` (uploads on the app origin with readable names, PDFs framed by self, `SameSite=Strict` + Origin check, caret ranges + lockfile, untrusted note content) were not reported as findings; their stated mitigations were checked in code and **all hold**.

## Results

| # | Category | Status | Report | Plan |
|---|----------|--------|--------|------|
| 1 | SECRETS_EXPOSURE | LOW | [report](reports/SECRETS_EXPOSURE_REPORT.md) | [plan](plans/SECRETS_EXPOSURE_PLAN.md) |
| 2 | DATABASE_ACCESS | N/A (no database) | [report](reports/DATABASE_ACCESS_REPORT.md) | – |
| 3 | AUTH_MIDDLEWARE | LOW | [report](reports/AUTH_MIDDLEWARE_REPORT.md) | [plan](plans/AUTH_MIDDLEWARE_PLAN.md) |
| 4 | ACCESS_CONTROL | PASS | [report](reports/ACCESS_CONTROL_REPORT.md) | – |
| 5 | FRONTEND_SECRETS | PASS | [report](reports/FRONTEND_SECRETS_REPORT.md) | – |
| 6 | SSRF | PASS (no outbound fetches) | [report](reports/SSRF_REPORT.md) | – |
| 7 | CSRF | LOW | [report](reports/CSRF_REPORT.md) | [plan](plans/CSRF_PLAN.md) |
| 8 | SECURITY_HEADERS | PASS (info only) | [report](reports/SECURITY_HEADERS_REPORT.md) | [plan](plans/SECURITY_HEADERS_PLAN.md) (optional) |
| 9 | CORS | PASS | [report](reports/CORS_REPORT.md) | – |
| 10 | RATE_LIMITING | **MEDIUM** | [report](reports/RATE_LIMITING_REPORT.md) | [plan](plans/RATE_LIMITING_PLAN.md) |
| 11 | SQL_INJECTION | N/A (no SQL) | [report](reports/SQL_INJECTION_REPORT.md) | – |
| 12 | XSS | PASS (info only) | [report](reports/XSS_REPORT.md) | [plan](plans/XSS_PLAN.md) (optional) |
| 13 | PAYMENT_WEBHOOKS | N/A (no payments) | [report](reports/PAYMENT_WEBHOOKS_REPORT.md) | – |
| 14 | FILE_UPLOADS | LOW | [report](reports/FILE_UPLOADS_REPORT.md) | [plan](plans/FILE_UPLOADS_PLAN.md) |
| 15 | ERROR_HANDLING | PASS | [report](reports/ERROR_HANDLING_REPORT.md) | – |
| 16 | PASSWORD_HASHING | N/A (passkeys only) | [report](reports/PASSWORD_HASHING_REPORT.md) | – |
| 17 | DEPENDENCIES | LOW | [report](reports/DEPENDENCIES_REPORT.md) | [plan](plans/DEPENDENCIES_PLAN.md) |

## Findings by severity

Critical 0 · High 0 · Medium 1 · Low 9 · Info 7

| ID | Sev | Finding | Evidence |
|---|---|---|---|
| RL-1 | Medium | `CF-Connecting-IP` honoured from any trusted proxy → login rate limit bypass with the README's Caddy/nginx/Traefik setups; enables evicting the owner's WebAuthn challenge (global FIFO cap 1000) = login DoS | `server/http/guards.ts:231-237`, `server/auth/passkeys.ts:108-110,325-336`, `README.md:86-127` |
| RL-2 | Low | No limits on authenticated heavy endpoints (50 MB uploads, unlimited SSE) | `server/http/routes/files.ts:262-307`, `routes/events.ts:121` |
| AUTH-1 | Low | Passkey add/remove with any session, no step-up; removing a passkey keeps its sessions | `server/http/routes/auth.ts:145-172` |
| AUTH-2 | Low | `requireUserVerification: false` | `server/auth/passkeys.ts:63,75` |
| CSRF-1 | Low | Session cookie without `__Host-` prefix | `server/http/guards.ts:202` |
| UP-1 | Low | Uploads buffered fully in memory | `server/http/routes/files.ts:268` |
| SEC-1 | Low | `.env`/`.env.*` not in `.gitignore` | `.gitignore` |
| DEP-0 | Low | 3 low npm advisories (nested KaTeX 0.16.47, not bundled, not exploitable) | `npm audit` |
| DEP-1 | Low | Client-side libs are devDependencies → `--omit=dev` audit blind to them; no audit in CI | `package.json`, `.github/workflows/image.yml` |
| DEP-2 | Low | Actions/base images pinned by mutable tags (release job can push packages) | `.github/workflows/image.yml`, `docker/Dockerfile` |
| AUTH-3 | Info | First setup link in container log (by design) | `server/cli.ts:507-508` |
| HDR-1 | Info | `X-Frame-Options: SAMEORIGIN` (needed for PDFs; CSP governs) | helmet default |
| HDR-2 | Info | No `Permissions-Policy` | – |
| XSS-1 | Info | Renderer keeps external images, CSP blocks them | `web/src/lib/markdown/render.ts:224`, `server/http/app.ts:129` |
| XSS-2 | Info | Mermaid SVG via innerHTML relies on Mermaid strict mode + CSP | `web/src/lib/markdown/mermaid.ts:24-32` |
| UP-2 | Info | No magic-byte check (accepted exception; MIME by extension + nosniff) | `server/vault/files.ts:165` |
| UP-3 | Info | Symlink check-then-use window (needs vault write access) | `server/vault/paths.ts:365-394` |

## Tool results

- `npm audit --omit=dev`: 0 vulnerabilities. `npm audit`: 3 low (see DEP-0).
- `gitleaks`, `semgrep`: not installed (not installed by the audit; install commands in the SECRETS_EXPOSURE report). Manual secret greps over source and git history: no hits.
- Live scan `check.py http://localhost:3095 --local` against the local `dist/` build (temp vault copy of `e2e/fixture-vault`, temp DATA_DIR; server stopped and temp dirs removed afterwards): **0 FAIL, 0 WARN, 18 PASS** (65 requests). Limitations: HSTS/HTTPS checks skipped by the scanner on localhost (header is present: `max-age=31536000; includeSubDomains`), no reverse-proxy/CDN headers, cookies only visible after login.
- Manual probes on the same instance: all protected `/api/*` routes and unknown `/api/*` → 401; foreign or missing `Origin` on POST → 403; invalid setup token → 403; 12 login-options requests with spoofed `X-Forwarded-For` (no `TRUST_PROXY`) → 10×200, 2×429; DATA_DIR files mode 0600.

## Critical issues

None. No Critical or High findings. The one Medium (RL-1) only applies when `TRUST_PROXY` is set behind a proxy that does not strip `CF-Connecting-IP` — which is every non-Cloudflare example in the README — and its impact is login denial of service, not data access.

## Remaining manual verification

- After deployment: run `python3 -I .claude/skills/vibe-check/scripts/check.py https://<PUBLIC_URL>` (HSTS, proxy/CDN headers, CORS) and record before/after counts here.
- After login: DevTools → Cookies, check the session cookie flags (and `__Host-` name once CSRF-1 is fixed).
- Behind the real proxy: send 12 `login/options` requests with varying `CF-Connecting-IP`; the last 2 must be 429 (RL-1).
- Step-up flow in the browser when adding/removing a passkey (AUTH-1, if implemented); decide on UV (AUTH-2).
- Large upload / pasted image still work (UP-1); PDFs still render embedded (HDR-1 if changed).
- Optionally install gitleaks and scan before making the repo public; enable Dependabot.

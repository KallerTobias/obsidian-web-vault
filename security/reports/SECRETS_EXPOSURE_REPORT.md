# Secrets Exposure Security Report

## Status: LOW

## Findings

- The app needs **no secrets in configuration**: env vars are `PUBLIC_URL`, `PORT`, `HOST`, `VAULT_DIR`, `DATA_DIR`, `SESSION_DAYS`, `TRUST_PROXY`, `EXCLUDE_PATHS`, `READONLY_PATHS`, `UMASK` (`server/config.ts`). Runtime secrets (session token hashes, setup token hash, passkey public keys) live in `DATA_DIR` JSON files, written with mode 0600 (observed locally), outside the vault and outside the served directory.
- `grep` over all tracked source/config for `sk_live_`, `sk_test_`, `AKIA…`, `-----BEGIN`, `password =`, `secret =`, `ghp_…`: no hits. `git log --all -p` for key patterns: no hits.
- `git ls-files`: no `.env`, keys or dumps tracked. No `.env.example` exists (not needed, `compose.example.yml` documents all variables with placeholder values).
- Served content: only `dist/web` via `@fastify/static` with `wildcard: false` (one route per file found at startup, `server/http/app.ts:89-100`). Local scan: 20 sensitive paths (`/.env`, `/.git/config`, dumps, keys, logs) not served, no directory listing on 12 folders.
- `.dockerignore` excludes `.env`, `.git`, `.claude`, tests, docs.
- CI uses only `GITHUB_TOKEN` (`.github/workflows/image.yml`).
- Logger redacts `cookie`, `authorization`, `set-cookie` and request bodies (`app.ts:68-71`); the setup token is in the URL fragment so it never reaches access logs.

### SEC-1 (Low): `.gitignore` does not list `.env` / `.env.*`

`.gitignore` contains only `.superpowers/ node_modules/ dist/ playwright-report/ test-results/`. AGENTS.md requires `.env` in `.gitignore` before one is created. Today there is no secret to leak, but a future `.env` or a copied `compose.yml` with real host paths would be committable. Add `.env`, `.env.*`, `!.env.example`, `compose.yml`.

### Tools

- `gitleaks`: **not installed** (install: `go install github.com/gitleaks/gitleaks/v8@latest` or download a release binary; then `gitleaks detect --source . --verbose`).
- `semgrep`: **not installed** (install: `pipx install semgrep`; then `semgrep --config auto`).

## What's at risk

Nothing today.

## What's already secure

No configuration secrets at all; hashed tokens at rest with restrictive file modes; build-output-only static serving; log redaction.

## Recommendations

1. Add `.env`, `.env.*`, `!.env.example`, `compose.yml` to `.gitignore`.
2. Run gitleaks once before making the repository public.

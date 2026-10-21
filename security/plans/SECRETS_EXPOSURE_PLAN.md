# Secrets Exposure Fix Plan

## Changes

- `.gitignore` — add `.env`, `.env.*`, `!.env.example`, `compose.yml`.

## New files

None.

## Verification goals

- [ ] `git check-ignore .env compose.yml` prints both.
- [ ] `git ls-files .env` returns nothing.
- [ ] `/.env` and `/.git/config` return 404 on the deployed app (live scan).

## Manual verification (for the human)

- Optionally install gitleaks and run `gitleaks detect --source . --verbose` before publishing the repository.

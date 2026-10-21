# Dependencies Fix Plan

## Changes

- `package.json` — `"overrides": { "micromark-extension-math": { "katex": "$katex" } }`; run `npm install` to update `package-lock.json`.
- `.github/workflows/image.yml` — add step `npm audit --audit-level=high` after `npm ci`; replace `uses: …@vN` with `uses: …@<full commit sha> # vN`.
- `docker/Dockerfile` — optionally pin `node:22-alpine` and `alpine:3.24` by digest.

## New files

- `.github/dependabot.yml` — ecosystems `npm` and `github-actions` (and `docker`), weekly.

## Verification goals

- [ ] `npm audit` → 0 vulnerabilities; `npm audit --omit=dev` → 0.
- [ ] `npm ls katex` shows only 0.19.x.
- [ ] Build, unit tests and e2e still pass; math still renders.
- [ ] Every `uses:` in the workflow references a 40-character SHA.

## Manual verification (for the human)

- Enable Dependabot alerts in the GitHub repository settings.

# Dependencies Security Report

## Status: LOW

## Findings

### npm audit

- `npm audit --omit=dev`: **found 0 vulnerabilities** (106 production packages).
- `npm audit` (all): **3 low** — GHSA-238p-pmpm-9mq7 "KaTeX: existing prototype pollution can bypass trust restrictions" in `katex 0.16.47` at `node_modules/micromark-extension-math/node_modules/katex`, pulled in by `remark-math` → `micromark-extension-math`. That copy is only imported by `micromark-extension-math/lib/html.js` (micromark HTML compiler), which the app does not use. Verified: the built bundle contains KaTeX `0.19.0` (the app's own, patched) and no `0.16.47`. Not exploitable here; the suggested `npm audit fix --force` (downgrade to remark-math 3) must **not** be applied. Fix with an `overrides` entry `"micromark-extension-math": { "katex": "$katex" }` or wait for upstream.

### Pinning and lockfiles

- Caret ranges in `package.json` + committed `package-lock.json` (deliberate exception). The exception holds: the lockfile is tracked, the Dockerfile and CI use `npm ci` (lockfile-exact), production stage uses `npm ci --omit=dev --ignore-scripts`.
- `tools/svelte-check` has its own committed lockfile.
- All direct dependencies are well-known packages from their official publishers (fastify/@fastify/*, @simplewebauthn, chokidar, dayjs, minisearch, picomatch, yaml; unified/remark/rehype/micromark, CodeMirror, Svelte, Vite, KaTeX, Mermaid, force-graph). No typo-squat-looking names.

### DEP-1 (Low): devDependencies ship to the browser but are excluded from `--omit=dev`

The whole frontend (Svelte, CodeMirror, unified/rehype-sanitize, KaTeX, Mermaid, force-graph) is in `devDependencies` because it is bundled at build time. `npm audit --omit=dev` therefore says nothing about the code that renders untrusted notes. CI does not run `npm audit` at all. Run full `npm audit --audit-level=high` in CI.

### DEP-2 (Low): CI actions and base images pinned by mutable tags

`.github/workflows/image.yml` uses `actions/checkout@v4`, `docker/*-action@v3/v5/v6` (tags, not commit SHAs); the release job has `packages: write`. `docker/Dockerfile` uses `node:22-alpine` and `alpine:3.24` without digests. A compromised action tag could publish a backdoored image. Pin actions to full commit SHAs (Dependabot can keep them updated) and optionally base images to digests.

### Tools

- `semgrep` and `gitleaks` not installed (see SECRETS_EXPOSURE report for install commands).

## What's at risk

DEP-1: a future advisory in the client-side rendering stack would go unnoticed. DEP-2: supply-chain compromise of the published image.

## What's already secure

0 production vulnerabilities, committed lockfiles, `npm ci`, `--ignore-scripts` in the runtime install, non-root runtime user (entrypoint refuses PUID/PGID 0), minimal runtime image.

## Recommendations

1. Add `npm audit --audit-level=high` (full tree) to CI.
2. Add an `overrides` entry so the nested KaTeX resolves to the app's 0.19.x, silencing the 3 lows.
3. Pin GitHub Actions to commit SHAs; add Dependabot for `github-actions` and `npm`.

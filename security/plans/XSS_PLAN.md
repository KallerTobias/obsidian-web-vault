# XSS Fix Plan

## Changes

- `web/src/lib/markdown/render.ts` (`rehypeHardenAndMath`, img branch) — replace external `<img>` with a link (`<a href>` with the external hardening) or drop it, matching CSP `img-src`. Alternatively document the CSP block as intended.
- `web/src/lib/editor/block-widgets.ts` — same rule for image widgets in live preview, if they accept external URLs.
- CI (`.github/workflows/image.yml`) — run `npm audit --audit-level=high` without `--omit=dev`, because devDependencies are bundled into the client.

## New files

- Test in `tests/web/render.test.ts`: `![x](https://example.com/a.png)` renders no `<img>` with external src.

## Verification goals

- [ ] Rendered HTML never contains `<img src="http…">`.
- [ ] Existing render/XSS tests (including `e2e/security.spec.ts`) pass.
- [ ] No CSP violations in the console when opening a note with external image syntax.

## Manual verification (for the human)

- Open a note with an external image in reading view and live preview; it appears as a link, no broken image, no console CSP error.

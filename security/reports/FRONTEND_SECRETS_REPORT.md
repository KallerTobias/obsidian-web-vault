# Frontend Secrets Security Report

## Status: PASS

## Findings

- Frontend (`web/src/**`) calls only the same-origin `/api/*` (`web/src/lib/api.ts`, `credentials: 'same-origin'`); no third-party APIs, no API keys, no `import.meta.env` usage at all (`grep -rn "import.meta.env" web/src` → no hits).
- Source maps: `web/vite.config.ts` does not enable `build.sourcemap`; `dist/web/assets` contains no `.map` files (the only `map` hit is `mindmap-definition-*.js`); local scan "No public source maps" PASS. The Docker deps stage also deletes `*.map` from `node_modules`.
- Secrets in the browser: only the WebAuthn options (public) and the HttpOnly session cookie (not readable by JS). The setup token is read from the URL fragment by the setup page and sent in a POST body.

## What's at risk

Nothing.

## What's already secure

All of the above.

## Recommendations

None.

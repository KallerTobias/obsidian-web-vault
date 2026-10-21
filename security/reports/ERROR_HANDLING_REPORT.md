# Error Handling Security Report

## Status: PASS

## Findings

- Global error handler `server/http/app.ts:155-163`: `HttpError` → its fixed German message; 429/413 → fixed messages; any other 4xx (including Ajv validation and JSON parse errors) → generic `Ungültige Anfrage`; everything else → logged server-side (`req.log.error({ err })`) and answered `500 {"error":"Interner Fehler"}`. No stack traces, file paths or library names reach the client.
- Vault errors are mapped to fixed messages and never forward Node's fs messages (which contain absolute paths) (`server/http/vault-errors.ts:273-306`); unknown errors stay 500.
- Not-found handler returns `{"error":"Nicht gefunden"}` for API and non-HTML requests (`app.ts:166-171`).
- No debug/docs endpoints exist (no Swagger, GraphQL, etc.). Local scan: 21 debug/docs paths checked, none exposed; error pages do not leak internals.
- `NODE_ENV=production` in the image; Fastify has no debug error page.
- `ConflictError` responses return the current disk content of the note — the owner's own data, intended for conflict resolution.
- Logging: credentials redacted; request URLs (including vault paths in `?path=`) are logged at info level — acceptable for a single-user app; mention in README if logs are shipped elsewhere.

## What's at risk

Nothing found.

## What's already secure

All of the above.

## Recommendations

None required.

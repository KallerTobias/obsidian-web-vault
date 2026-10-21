# File Uploads Security Report

## Status: LOW

Uploads deliberately stay ordinary vault files with readable names on the app origin (AGENTS.md exception). This report checks whether the stated mitigations hold.

## Findings

Upload endpoint: `POST /api/attachment` (`server/http/routes/files.ts:262-307`); served via `GET /api/file` (`:229-260`).

| Stated mitigation | Holds? | Evidence |
|---|---|---|
| Every file response requires a session | ✓ | global default-deny hook `server/http/app.ts:61-65,150-153`; local probe `/api/file?path=…` → 401 |
| `X-Content-Type-Options: nosniff` | ✓ | `files.ts:235` + helmet globally |
| `Content-Disposition: attachment` except images/PDF/audio/video | ✓ | `files.ts:72-77`; MIME is chosen by the server from a fixed extension map, unknown → `application/octet-stream` (`server/vault/files.ts:41-66,165`), so `.html`/`.xml`/`.js` uploads are downloads, never rendered |
| SVG with `Content-Security-Policy: sandbox` | ✓ | `files.ts:239` |
| PDF only framed by self | ✓ | `files.ts:242` |
| Server-side name validation | ✓ | `sanitizeFileName` `files.ts:35-45` (no path parts, reserved/control chars, leading dots, length); new names via `assertValidNewName`; path containment and hidden/excluded/readonly checks in `server/vault/paths.ts` / `files.ts:137-143`; atomic create without overwrite (`link()`), unique names |
| Size limit server-side | ✓ | multipart `fileSize: 50 MB, files: 1, parts: 11` (`app.ts:140-142`); notes 10 MB |

### UP-1 (Low): uploads are fully buffered in memory

`part.toBuffer()` (`files.ts:268`) holds up to 50 MB per request in RAM; parallel uploads by an authenticated client multiply that. Stream to the temp file instead (the code already writes via a temp file + `link`). Same root as RATE_LIMITING RL-2.

### UP-2 (Info): content is not checked against the extension (no magic bytes)

Accepted by the exception. Impact is limited because the response type comes only from the extension and is always `nosniff`; a fake `.png` with HTML inside is served as `image/png` and not rendered as HTML. Pasted images take their extension from the client MIME (`files.ts:281-283`) from a 4-entry allowlist, default `.png`.

### UP-3 (Info): check-then-use window for symlinks

`VaultPaths.safeResolve` resolves symlinks and then the caller opens the path (`paths.ts:365-394`, `files.ts:137-167`). A process with write access to the vault (Syncthing peer, AI agent) could swap a directory for a symlink in between and make one read/write escape the vault. Requires vault write access and precise timing; mitigate with `O_NOFOLLOW` on the final open plus re-checking `realpath` of the opened fd (`/proc/self/fd`) if this threat matters.

## What's at risk

UP-1: memory exhaustion by a logged-in client. UP-3: theoretical vault escape by an already-privileged local writer.

## What's already secure

All stated mitigations of the exception, plus: upload limited to 1 file and 11 parts, field sizes capped, filename never trusted for the folder, attachment folder setting cannot point into hidden paths (guarded mkdir), Range requests validated (416 on bad ranges).

## Recommendations

1. Stream uploads to disk instead of `toBuffer()`.
2. Optional: O_NOFOLLOW / fd-realpath re-check for UP-3.

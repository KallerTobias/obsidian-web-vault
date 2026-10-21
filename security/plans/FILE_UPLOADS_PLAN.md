# File Uploads Fix Plan

## Changes

- `server/http/routes/files.ts` (`POST /api/attachment`) — pipe `part.file` into a temp file in the target folder (hash while streaming), then `link()` it to the unique name; abort and delete the temp file on `part.file.truncated` / 413.
- `server/vault/files.ts` — add `createExclusiveFromStream(rel, stream)` reusing `guard`, `writeTemp` logic and `link`.
- (optional, UP-3) `server/vault/files.ts` — open final files with `O_NOFOLLOW` and verify the fd's real path is inside the vault before reading/writing.

## New files

- Tests: upload of 50 MB + 1 byte → 413 and no temp file left; normal upload still produces the same name/version.

## Verification goals

- [ ] Peak RSS during a 50 MB upload grows by far less than 50 MB.
- [ ] Oversized upload → 413, no `*.tmp` remains in the vault.
- [ ] `/api/file` still sends nosniff, attachment for non-media, sandbox CSP for SVG.
- [ ] Existing `tests/server/api.test.ts` and `e2e/files.spec.ts` pass.

## Manual verification (for the human)

- Upload a large video and a pasted screenshot in the browser; both appear and play.

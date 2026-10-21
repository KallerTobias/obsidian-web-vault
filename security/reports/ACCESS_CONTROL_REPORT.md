# Access Control Security Report

## Status: PASS

## Findings

vault-web has exactly one user, so there is no cross-user ownership (`current_user.id == resource.owner_id` does not apply): every valid session owns every resource. The "resource IDs" that need checking are:

- **Vault paths** (`?path=`, `from`/`to`, `notePath`): every route normalizes with `normalizeRel` (NFC, posix normalize, rejects leading `/`, NUL and `..` escape, `server/vault/paths.ts:330-338`); file access goes through `VaultFiles.guard` (hidden `.`-paths and `EXCLUDE_PATHS` → 404, `READONLY_PATHS` → 403 on write, `server/vault/files.ts:137-143`) and `safeResolve` (realpath of the nearest existing ancestor must stay in the vault, dangling symlinks rejected, symlinks may not redirect into hidden/excluded areas, `paths.ts:365-426`). Rename/trash check every entry of a moved folder (`server/vault/ops.ts:139-176`). Verified locally: `/api/note?path=../../etc/passwd` → 401 before auth; tests cover traversal after auth (`tests/server/paths.test.ts`, `api.test.ts`).
- **Index/search**: the watcher never indexes hidden or excluded paths (`server/vault/watcher.ts:110-121`), so `/api/search`, `/api/backlinks`, `/api/lookup`, `/api/graph`, `/api/meta` cannot leak excluded notes.
- **Passkey and session IDs** (`/api/auth/passkeys/:id`, `/api/auth/sessions/:id`): single user, all belong to the owner; unknown IDs → 404.
- Errors for hidden/excluded paths answer 404 so existence is not revealed (`server/http/vault-errors.ts:289-299`).

See FILE_UPLOADS UP-3 (Info) for the symlink check-then-use window, which needs vault write access.

## What's at risk

Nothing found.

## What's already secure

Everything above; vault root cannot be renamed/trashed; trash is a move to `.trash/` (recoverable), not a delete.

## Recommendations

None required.

# Database Access Security Report

## Status: N/A

No database, Supabase or Firebase. State lives in JSON files in `DATA_DIR` (`server/store/json-store.ts`: passkeys, sessions, setup token, settings) written atomically with mode 0600, outside the vault and not reachable over HTTP; notes are files in the vault. Access control for those is covered in AUTH_MIDDLEWARE and ACCESS_CONTROL.

# Password Hashing Security Report

## Status: N/A

Passkey-only authentication, no passwords exist. Related note: bearer secrets (session and setup tokens, 256-bit random) are stored as plain SHA-256, which is correct for high-entropy tokens (no slow hash needed) and compared in constant time (`server/auth/token-hash.ts`).

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** New secret token: 32 random bytes, base64url (43 characters). */
export const newToken = (): string => randomBytes(32).toString('base64url');

/** sha256 of the token as hex – the only form in which tokens are stored. */
export const hashToken = (token: string): string => createHash('sha256').update(token, 'utf8').digest('hex');

/** Constant-time comparison of two hex hashes; missing, malformed or differently sized input is never equal. */
export function sameHash(a: unknown, b: unknown): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const x = Buffer.from(a, 'hex');
  const y = Buffer.from(b, 'hex');
  return x.length === 32 && y.length === 32 && timingSafeEqual(x, y);
}

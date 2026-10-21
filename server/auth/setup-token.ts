import { join } from 'node:path';
import { JsonStore } from '../store/json-store';
import { hashToken, newToken, sameHash } from './token-hash';

/** Validity of a setup link. */
const VALIDITY_MS = 60 * 60 * 1000;

interface SetupTokenFile {
  /** sha256(token) as hex, `null` when no link is open. */
  tokenHash: string | null;
  expiresAt: number;
}

export interface SetupTokensOptions {
  dataDir: string;
  now?: () => number;
}

/**
 * One-time setup token (for registering a passkey) in `<dataDir>/setup-token.json`.
 * Only one token is open at a time: issuing a new one invalidates the previous link.
 * Reads pick up tokens issued or consumed by another process (CLI next to the server).
 */
export class SetupTokens {
  private readonly store: JsonStore<SetupTokenFile>;
  private readonly now: () => number;

  private constructor(opts: SetupTokensOptions) {
    this.store = new JsonStore<SetupTokenFile>(join(opts.dataDir, 'setup-token.json'), {
      tokenHash: null,
      expiresAt: 0,
    });
    this.now = opts.now ?? Date.now;
  }

  static async open(opts: SetupTokensOptions): Promise<SetupTokens> {
    const t = new SetupTokens(opts);
    await t.store.load();
    return t;
  }

  /** Issues a new token (plain text, 32 bytes base64url), valid for 60 minutes. */
  async issue(): Promise<string> {
    const token = newToken();
    await this.store.update(() => ({ tokenHash: hashToken(token), expiresAt: this.now() + VALIDITY_MS }));
    return token;
  }

  /**
   * Whether the token is the open, unexpired one – without redeeming it (lets the setup page
   * start a passkey ceremony; the token is consumed only once a passkey was verified).
   */
  async check(token: string): Promise<boolean> {
    if (typeof token !== 'string' || token === '' || !(await this.active())) return false;
    return sameHash(this.store.get().tokenHash ?? '', hashToken(token));
  }

  /** Redeems the token. `true` exactly once while it is valid; afterwards always `false`. */
  async consume(token: string): Promise<boolean> {
    if (typeof token !== 'string' || token === '' || !(await this.active())) return false;
    const hash = hashToken(token);
    // Wrong guesses never touch the disk.
    if (!sameHash(this.store.get().tokenHash ?? '', hash)) return false;
    let ok = false;
    await this.store.update((f) => {
      // Re-checked inside the serialized update so parallel calls cannot both succeed.
      if (f.tokenHash === null || f.expiresAt <= this.now() || !sameHash(f.tokenHash, hash)) return;
      ok = true;
      return { tokenHash: null, expiresAt: 0 };
    });
    return ok;
  }

  /** Whether an unused, unexpired token exists. */
  async active(): Promise<boolean> {
    await this.store.refresh();
    const f = this.store.get();
    return f.tokenHash !== null && f.expiresAt > this.now();
  }
}

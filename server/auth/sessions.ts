import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { JsonStore } from '../store/json-store';
import { hashToken, newToken, sameHash } from './token-hash';

export interface Session {
  id: string;
  createdAt: number;
  lastSeen: number;
  expiresAt: number;
  userAgent: string;
  ip: string;
}

interface StoredSession extends Session {
  /** sha256(token) as hex; the token itself is never stored. */
  tokenHash: string;
}

interface SessionsFile {
  sessions: StoredSession[];
}

export interface SessionStoreOptions {
  dataDir: string;
  sessionDays: number;
  now?: () => number;
}

/** Validation persists the sliding expiry at most this often per session. */
const WRITE_INTERVAL_MS = 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

const toPublic = ({ tokenHash: _hash, ...session }: StoredSession): Session => session;

/**
 * Login sessions in `<dataDir>/sessions.json`, with sliding expiry of `sessionDays`.
 * Every public method first picks up changes made by another process (e.g. `reset-passkeys`).
 */
export class SessionStore {
  private readonly store: JsonStore<SessionsFile>;
  private readonly now: () => number;
  private readonly lifetimeMs: number;

  private constructor(opts: SessionStoreOptions) {
    this.store = new JsonStore<SessionsFile>(join(opts.dataDir, 'sessions.json'), { sessions: [] });
    this.now = opts.now ?? Date.now;
    this.lifetimeMs = opts.sessionDays * DAY_MS;
  }

  /** Loads the sessions and prunes expired ones. */
  static async open(opts: SessionStoreOptions): Promise<SessionStore> {
    const s = new SessionStore(opts);
    await s.store.load();
    if ((await s.current()).some((x) => s.expired(x))) await s.store.update((f) => s.prune(f));
    return s;
  }

  /** Current sessions from disk (re-read only if the file changed). */
  private async current(): Promise<StoredSession[]> {
    await this.store.refresh();
    const { sessions } = this.store.get();
    if (!Array.isArray(sessions)) {
      throw new Error('sessions.json hat ein unerwartetes Format (sessions ist keine Liste)');
    }
    return sessions;
  }

  /** Creates a session and returns its token (plain text, only ever given to the client). */
  async create(meta: { userAgent: string; ip: string }): Promise<string> {
    const token = newToken();
    const now = this.now();
    const session: StoredSession = {
      id: randomBytes(16).toString('base64url'),
      tokenHash: hashToken(token),
      createdAt: now,
      lastSeen: now,
      expiresAt: now + this.lifetimeMs,
      userAgent: meta.userAgent,
      ip: meta.ip,
    };
    await this.store.update((f) => {
      this.prune(f);
      f.sessions.push(session);
    });
    return token;
  }

  /**
   * Returns the session for the token or `null`. Extends the expiry (sliding), but writes
   * to disk at most once per hour per session. Expired sessions are pruned.
   */
  async validate(token: string): Promise<Session | null> {
    if (typeof token !== 'string' || token === '') return null;
    const hash = hashToken(token);
    const found = (await this.current()).find((s) => sameHash(s.tokenHash, hash));
    const now = this.now();
    if (!found) return null;
    if (this.expired(found)) {
      await this.store.update((f) => this.prune(f));
      return null;
    }
    if (now - found.lastSeen < WRITE_INTERVAL_MS) return toPublic(found);

    let result: Session | null = null;
    await this.store.update((f) => {
      this.prune(f);
      const s = f.sessions.find((x) => x.id === found.id);
      if (!s) return;
      s.lastSeen = now;
      s.expiresAt = now + this.lifetimeMs;
      result = toPublic(s);
    });
    return result;
  }

  /** Like `validate`, but read-only: no sliding expiry, no writes (for periodic re-checks). */
  async peek(token: string): Promise<Session | null> {
    if (typeof token !== 'string' || token === '') return null;
    const hash = hashToken(token);
    const found = (await this.current()).find((s) => sameHash(s.tokenHash, hash));
    return found && !this.expired(found) ? toPublic(found) : null;
  }

  async revoke(id: string): Promise<void> {
    await this.store.update((f) => {
      f.sessions = f.sessions.filter((s) => s.id !== id);
    });
  }

  /** Removes all sessions, except the one with `exceptId` if given. */
  async revokeAll(exceptId?: string): Promise<void> {
    await this.store.update((f) => {
      f.sessions = f.sessions.filter((s) => exceptId !== undefined && s.id === exceptId);
    });
  }

  /** Active sessions, without token hashes. */
  async list(): Promise<Session[]> {
    return (await this.current()).filter((s) => !this.expired(s)).map(toPublic);
  }

  private expired(s: Session): boolean {
    return s.expiresAt <= this.now();
  }

  private prune(f: SessionsFile): void {
    f.sessions = f.sessions.filter((s) => !this.expired(s));
  }
}

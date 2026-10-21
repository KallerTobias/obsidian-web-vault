import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SessionStore } from '../../server/auth/sessions';
import { SetupTokens } from '../../server/auth/setup-token';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

let dataDir: string;
let clock: number;
const now = () => clock;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'vw-auth-'));
  clock = Date.UTC(2026, 9, 19, 12);
});
afterEach(() => rm(dataDir, { recursive: true, force: true }));

const meta = { userAgent: 'Firefox', ip: '10.0.0.1' };
const openSessions = () => SessionStore.open({ dataDir, sessionDays: 14, now });
const sessionsFile = () => join(dataDir, 'sessions.json');

describe('SessionStore', () => {
  it('creates a session that validates with its metadata', async () => {
    const store = await openSessions();
    const token = await store.create(meta);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const s = await store.validate(token);
    expect(s).toMatchObject({ userAgent: 'Firefox', ip: '10.0.0.1', createdAt: clock, lastSeen: clock });
    expect(s?.expiresAt).toBe(clock + 14 * DAY);
    expect(await store.list()).toHaveLength(1);
  });

  it('rejects unknown, empty and malformed tokens', async () => {
    const store = await openSessions();
    await store.create(meta);
    expect(await store.validate('nope')).toBeNull();
    expect(await store.validate('')).toBeNull();
    expect(await store.validate(undefined as unknown as string)).toBeNull();
  });

  it('stores only the sha256 hash of the token, never the token itself', async () => {
    const store = await openSessions();
    const token = await store.create(meta);
    const raw = await readFile(sessionsFile(), 'utf8');
    expect(raw).not.toContain(token);
    const { createHash } = await import('node:crypto');
    expect(raw).toContain(createHash('sha256').update(token).digest('hex'));
    expect(JSON.stringify((await store.list()))).not.toContain(token);
    expect((await store.list())[0]).not.toHaveProperty('tokenHash');
  });

  it('returns null for an expired session and prunes it', async () => {
    const store = await openSessions();
    const token = await store.create(meta);
    clock += 14 * DAY + 1;
    expect(await store.validate(token)).toBeNull();
    expect(await store.list()).toEqual([]);
    expect(JSON.parse(await readFile(sessionsFile(), 'utf8')).sessions).toEqual([]);
  });

  it('prunes expired sessions on load', async () => {
    const store = await openSessions();
    await store.create(meta);
    clock += 3 * DAY;
    const fresh = await store.create(meta);
    clock += 12 * DAY;
    const reopened = await openSessions();
    expect(await reopened.list()).toHaveLength(1);
    expect(JSON.parse(await readFile(sessionsFile(), 'utf8')).sessions).toHaveLength(1);
    expect(await reopened.validate(fresh)).not.toBeNull();
  });

  it('extends expiresAt on validation (sliding)', async () => {
    const store = await openSessions();
    const token = await store.create(meta);
    clock += 10 * DAY;
    const s = await store.validate(token);
    expect(s?.expiresAt).toBe(clock + 14 * DAY);
    expect(s?.lastSeen).toBe(clock);
    clock += 10 * DAY; // past the original 14 days, still within the extended window
    expect(await store.validate(token)).not.toBeNull();
    const reopened = await openSessions();
    expect(await reopened.validate(token)).not.toBeNull();
  });

  it('peek checks a token without extending it, and fails for revoked/expired sessions', async () => {
    const store = await openSessions();
    const token = await store.create(meta);
    const created = clock;
    clock += 10 * DAY;
    expect(await store.peek(token)).toMatchObject({ lastSeen: created, expiresAt: created + 14 * DAY });
    expect(await store.peek('falsch')).toBeNull();
    clock += 5 * DAY;
    expect(await store.peek(token)).toBeNull();
    clock -= 5 * DAY;
    await store.revokeAll();
    expect(await store.peek(token)).toBeNull();
  });

  it('writes to disk at most once per hour per session', async () => {
    const store = await openSessions();
    const token = await store.create(meta);
    const before = await readFile(sessionsFile(), 'utf8');
    clock += 30 * MIN;
    await store.validate(token);
    expect(await readFile(sessionsFile(), 'utf8')).toBe(before);
    clock += 31 * MIN;
    await store.validate(token);
    const after = JSON.parse(await readFile(sessionsFile(), 'utf8'));
    expect(after.sessions[0].lastSeen).toBe(clock);
  });

  it('revokes a single session', async () => {
    const store = await openSessions();
    const a = await store.create(meta);
    const b = await store.create(meta);
    const idA = (await store.validate(a))!.id;
    await store.revoke(idA);
    expect(await store.validate(a)).toBeNull();
    expect(await store.validate(b)).not.toBeNull();
  });

  it('revokeAll(except) keeps only the given session', async () => {
    const store = await openSessions();
    const a = await store.create(meta);
    const b = await store.create(meta);
    const c = await store.create(meta);
    const idB = (await store.validate(b))!.id;
    await store.revokeAll(idB);
    expect(await store.validate(a)).toBeNull();
    expect(await store.validate(c)).toBeNull();
    expect(await store.validate(b)).not.toBeNull();
    expect((await store.list()).map((s) => s.id)).toEqual([idB]);
  });

  it('revokeAll() without argument removes every session', async () => {
    const store = await openSessions();
    await store.create(meta);
    await store.create(meta);
    await store.revokeAll();
    expect(await store.list()).toEqual([]);
  });

  it('sees revocations by another instance and does not resurrect them on its next write', async () => {
    const a = await openSessions();
    const b = await openSessions();
    const token = await a.create(meta);
    const keep = await a.create(meta);
    const id = (await a.validate(token))!.id;
    await b.revoke(id);
    expect(await a.validate(token)).toBeNull();
    await a.create(meta); // a write in A
    const stored = JSON.parse(await readFile(sessionsFile(), 'utf8')).sessions as { id: string }[];
    expect(stored.map((s) => s.id)).not.toContain(id);
    expect(stored).toHaveLength(2);
    expect(await a.validate(keep)).not.toBeNull();
  });

  it('sees revokeAll() by another instance (reset-passkeys from the CLI)', async () => {
    const a = await openSessions();
    const token = await a.create(meta);
    const b = await openSessions();
    await b.revokeAll();
    expect(await a.validate(token)).toBeNull();
    expect(await a.list()).toEqual([]);
    clock += 2 * HOUR;
    await a.create(meta);
    expect(JSON.parse(await readFile(sessionsFile(), 'utf8')).sessions).toHaveLength(1);
  });

  it('sees sessions created by another instance', async () => {
    const a = await openSessions();
    const b = await openSessions();
    const token = await b.create(meta);
    expect(await a.validate(token)).not.toBeNull();
  });

  it('rejects a sessions.json with the wrong shape', async () => {
    await writeFile(sessionsFile(), JSON.stringify({ sessions: { x: 1 } }));
    await expect(openSessions()).rejects.toThrow(/unerwartetes Format/);
  });

  it('survives entries with missing or non-string tokenHash', async () => {
    const base = { createdAt: clock, lastSeen: clock, expiresAt: clock + DAY, userAgent: '', ip: '' };
    await writeFile(
      sessionsFile(),
      JSON.stringify({ sessions: [{ ...base, id: 'a' }, { ...base, id: 'b', tokenHash: 42 }, { ...base, id: 'c', tokenHash: null }] }),
    );
    const store = await openSessions();
    expect(await store.validate('anything')).toBeNull();
  });

  it('survives a corrupt hash entry without throwing', async () => {
    await writeFile(
      sessionsFile(),
      JSON.stringify({
        sessions: [{ id: 'x', tokenHash: 'abc', createdAt: clock, lastSeen: clock, expiresAt: clock + DAY, userAgent: '', ip: '' }],
      }),
    );
    const store = await openSessions();
    expect(await store.validate('anything')).toBeNull();
  });
});

describe('SetupTokens', () => {
  const openTokens = () => SetupTokens.open({ dataDir, now });

  it('issues a 32-byte base64url token that can be consumed once', async () => {
    const tokens = await openTokens();
    expect(await tokens.active()).toBe(false);
    const t = await tokens.issue();
    expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await tokens.active()).toBe(true);
    expect(await tokens.consume(t)).toBe(true);
    expect(await tokens.consume(t)).toBe(false);
    expect(await tokens.active()).toBe(false);
  });

  it('does not allow two parallel consumptions to both succeed', async () => {
    const tokens = await openTokens();
    const t = await tokens.issue();
    const results = await Promise.all([tokens.consume(t), tokens.consume(t)]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('expires after 60 minutes', async () => {
    const tokens = await openTokens();
    const t = await tokens.issue();
    clock += 61 * MIN;
    expect(await tokens.active()).toBe(false);
    expect(await tokens.consume(t)).toBe(false);
  });

  it('is still valid shortly before 60 minutes', async () => {
    const tokens = await openTokens();
    const t = await tokens.issue();
    clock += 59 * MIN;
    expect(await tokens.consume(t)).toBe(true);
  });

  it('check() tells whether a token is valid without consuming it', async () => {
    const tokens = await openTokens();
    expect(await tokens.check('')).toBe(false);
    const t = await tokens.issue();
    expect(await tokens.check('falsch')).toBe(false);
    expect(await tokens.check(t)).toBe(true);
    expect(await tokens.check(t)).toBe(true);
    clock += 61 * MIN;
    expect(await tokens.check(t)).toBe(false);
  });

  it('rejects wrong tokens without consuming the real one', async () => {
    const tokens = await openTokens();
    const t = await tokens.issue();
    expect(await tokens.consume('falsch')).toBe(false);
    expect(await tokens.consume('')).toBe(false);
    expect(await tokens.consume(t)).toBe(true);
  });

  it('a newly issued token replaces the previous one', async () => {
    const tokens = await openTokens();
    const old = await tokens.issue();
    const fresh = await tokens.issue();
    expect(await tokens.consume(old)).toBe(false);
    expect(await tokens.consume(fresh)).toBe(true);
  });

  it('a token issued by another instance (CLI) is accepted, and invalidates the old one', async () => {
    const server = await openTokens();
    const old = await server.issue();
    const cli = await openTokens();
    const fresh = await cli.issue();
    expect(await server.active()).toBe(true);
    expect(await server.consume(old)).toBe(false);
    expect(await server.consume(fresh)).toBe(true);
    expect(await cli.active()).toBe(false);
  });

  it('stores only the hash and persists across restarts', async () => {
    const tokens = await openTokens();
    const t = await tokens.issue();
    const raw = await readFile(join(dataDir, 'setup-token.json'), 'utf8');
    expect(raw).not.toContain(t);
    const reopened = await openTokens();
    expect(await reopened.active()).toBe(true);
    expect(await reopened.consume(t)).toBe(true);
  });
});

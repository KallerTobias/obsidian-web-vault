import { Writable } from 'node:stream';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SessionStore } from '../../server/auth/sessions';
import { SetupTokens } from '../../server/auth/setup-token';
import { PasskeyService, type WebAuthnVerifier } from '../../server/auth/passkeys';
import { loadConfig, type Config } from '../../server/config';
import { EventBus } from '../../server/events';
import { SearchIndex } from '../../server/index/search';
import { VaultIndex } from '../../server/index/vault-index';
import { buildApp, type AppDeps } from '../../server/http/app';
import { loadSettings } from '../../server/store/settings';
import { VaultFiles } from '../../server/vault/files';
import { VaultOps } from '../../server/vault/ops';
import { VaultPaths } from '../../server/vault/paths';

const ORIGIN = 'https://vault.example.com';
const MIN = 60_000;

/**
 * Fake verifier: a "response" is `{ id, challenge, ok? }`. It verifies when the challenge the
 * client "signed" is the one the server expects (and, for logins, the credential matches).
 */
/** `requireUserVerification` of every verification call (must always be true). */
let uvRequired: boolean[] = [];
type FakeResponse = { id: string; challenge: string; ok?: boolean; /** user verified (default true) */ uv?: boolean };
const fakeVerifier: WebAuthnVerifier = {
  async verifyRegistration({ response, expectedChallenge, expectedOrigin, expectedRPID, requireUserVerification }) {
    const r = response as FakeResponse;
    uvRequired.push(requireUserVerification);
    if (expectedOrigin !== ORIGIN || expectedRPID !== 'vault.example.com') return null;
    if (r.ok === false || r.challenge !== expectedChallenge) return null;
    if (requireUserVerification && r.uv === false) return null;
    return { id: r.id, publicKey: Buffer.from(`pk-${r.id}`).toString('base64url'), counter: 0, transports: ['internal'] };
  },
  async verifyAuthentication({ response, expectedChallenge, credential, requireUserVerification }) {
    const r = response as FakeResponse;
    uvRequired.push(requireUserVerification);
    if (r.ok === false || r.challenge !== expectedChallenge || r.id !== credential.id) return null;
    if (requireUserVerification && r.uv === false) return null;
    return { newCounter: credential.counter + 1 };
  },
};

let dataDir: string;
let vaultDir: string;
let clock: number;
let config: Config;
let sessions: SessionStore;
let setup: SetupTokens;
let passkeys: PasskeyService;
let app: FastifyInstance;

async function makeApp(env: Record<string, string> = {}, logStream?: Writable): Promise<FastifyInstance> {
  config = loadConfig({ PUBLIC_URL: ORIGIN, DATA_DIR: dataDir, VAULT_DIR: vaultDir, ...env });
  sessions = await SessionStore.open({ dataDir, sessionDays: config.sessionDays, now: () => clock });
  setup = await SetupTokens.open({ dataDir, now: () => clock });
  passkeys = await PasskeyService.open({
    dataDir,
    rpId: config.rpId,
    origin: config.publicUrl.origin,
    verifier: fakeVerifier,
    now: () => clock,
  });
  const paths = new VaultPaths(vaultDir, [], []);
  const files = new VaultFiles(paths);
  const index = new VaultIndex();
  const events = new EventBus();
  const noMarks = { markOwnWrite() {}, markOwnMove() {}, unmarkOwnMove() {} };
  const deps: AppDeps = {
    config,
    sessions,
    setup,
    passkeys,
    paths,
    files,
    ops: new VaultOps({ paths, files, index, bus: events, watcher: noMarks }),
    index,
    search: new SearchIndex(),
    events,
    settings: await loadSettings(dataDir, vaultDir),
    watcher: noMarks,
  };
  const a = buildApp(deps, logStream ? { logger: { level: 'info', stream: logStream } } : { logger: false });
  await a.ready();
  return a;
}

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'vw-authr-'));
  vaultDir = join(dataDir, 'vault');
  await mkdir(vaultDir);
  clock = Date.now();
  uvRequired = [];
  app = await makeApp();
});
afterEach(async () => {
  await app.close();
  await rm(dataDir, { recursive: true, force: true });
});

const post = (url: string, payload?: object, headers: Record<string, string> = {}) =>
  app.inject({ method: 'POST', url, payload, headers: { origin: ORIGIN, ...headers } });
const send = (method: 'GET' | 'PATCH' | 'DELETE', url: string, cookie?: string, payload?: object) =>
  app.inject({
    method,
    url,
    payload,
    headers: { ...(method === 'GET' ? {} : { origin: ORIGIN }), ...(cookie ? { cookie } : {}) },
  });

function setCookie(res: LightMyRequestResponse): string {
  const h = res.headers['set-cookie'];
  const list = Array.isArray(h) ? h : h ? [h] : [];
  const c = list.find((x) => x.startsWith('__Host-vw_session='));
  if (!c) throw new Error('no __Host-vw_session cookie');
  return c;
}
const cookiePair = (res: LightMyRequestResponse) => setCookie(res).split(';')[0]!;

/** Full setup ceremony with a freshly issued token. Returns the session cookie pair. */
async function doSetup(credId = 'cred-1', name = 'Laptop'): Promise<string> {
  const token = await setup.issue();
  const opt = await post('/api/auth/setup/options', { token });
  expect(opt.statusCode).toBe(200);
  const { options, challengeId } = opt.json();
  const res = await post('/api/auth/setup/verify', {
    token,
    challengeId,
    name,
    response: { id: credId, challenge: options.challenge },
  });
  expect(res.statusCode).toBe(200);
  return cookiePair(res);
}

/** Step-up with an existing passkey in the session of `cookie`. */
async function confirm(cookie: string, credId = 'cred-1', extra: object = {}): Promise<LightMyRequestResponse> {
  const opt = await post('/api/auth/passkeys/confirm/options', {}, { cookie });
  expect(opt.statusCode).toBe(200);
  const { options, challengeId } = opt.json();
  return post('/api/auth/passkeys/confirm', { challengeId, response: { id: credId, challenge: options.challenge, ...extra } }, { cookie });
}

async function loginOptions(headers: Record<string, string> = {}) {
  return post('/api/auth/login/options', {}, headers);
}

async function doLogin(credId = 'cred-1'): Promise<LightMyRequestResponse> {
  const { options, challengeId } = (await loginOptions()).json();
  return post('/api/auth/login/verify', { challengeId, response: { id: credId, challenge: options.challenge } });
}

describe('basics', () => {
  it('GET /api/health → { ok: true }', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });

  it('GET /api/auth/state reveals only authenticated, setupRequired and the public origin', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/auth/state' });
    expect(res.json()).toEqual({ authenticated: false, setupRequired: true, publicOrigin: ORIGIN });
  });

  it('sets security headers (CSP, Referrer-Policy)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    const csp = String(res.headers['content-security-policy']);
    for (const d of [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ]) {
      expect(csp).toContain(d);
    }
    expect(csp).not.toContain('unsafe-eval');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
  });

  it('answers unknown routes and malformed JSON with a German JSON error, no stack', async () => {
    const nf = await app.inject({ method: 'GET', url: '/nope' });
    expect(nf.statusCode).toBe(404);
    expect(nf.json()).toEqual({ error: expect.any(String), code: 'NOT_FOUND' });
    const bad = await app.inject({
      method: 'POST',
      url: '/api/auth/login/verify',
      headers: { origin: ORIGIN, 'content-type': 'application/json' },
      payload: '{not json',
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toEqual({ error: 'Ungültige Anfrage', code: 'BAD_REQUEST' });
    expect(bad.body).not.toMatch(/at .*\.ts|stack/i);
  });
});

describe('same origin', () => {
  it('rejects POST without Origin and with a foreign Origin (403)', async () => {
    const none = await app.inject({ method: 'POST', url: '/api/auth/login/options', payload: {} });
    expect(none.statusCode).toBe(403);
    // `code` lets the client point to the right address (page opened under another origin).
    expect(none.json()).toEqual({ error: expect.any(String), code: 'ORIGIN' });
    const foreign = await post('/api/auth/login/options', {}, { origin: 'https://evil.example.com' });
    expect(foreign.statusCode).toBe(403);
    const sub = await post('/api/auth/login/options', {}, { origin: 'https://vault.example.com.evil.com' });
    expect(sub.statusCode).toBe(403);
  });

  it('rejects DELETE/PATCH without Origin even with a valid session', async () => {
    const cookie = await doSetup();
    const id = (await send('GET', '/api/auth/passkeys', cookie)).json()[0].id;
    const res = await app.inject({ method: 'DELETE', url: `/api/auth/passkeys/${id}?force=1`, headers: { cookie } });
    expect(res.statusCode).toBe(403);
    expect(await passkeys.hasPasskeys()).toBe(true);
  });

  it('allows GET without Origin', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/auth/state' })).statusCode).toBe(200);
  });
});

describe('setup', () => {
  it('rejects setup without or with a wrong token (403)', async () => {
    await setup.issue();
    expect((await post('/api/auth/setup/options', {})).statusCode).toBe(403);
    expect((await post('/api/auth/setup/options', { token: 'wrong' })).json().code).toBe('SETUP_DENIED');
    const res = await post('/api/auth/setup/verify', {
      token: 'wrong',
      challengeId: 'x',
      name: 'n',
      response: { id: 'a', challenge: 'b' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('SETUP_DENIED');
    expect(await passkeys.hasPasskeys()).toBe(false);
  });

  it('successful setup sets the session cookie with HttpOnly; Secure; SameSite=Strict', async () => {
    const token = await setup.issue();
    const { options, challengeId } = (await post('/api/auth/setup/options', { token })).json();
    expect(options.rp.id).toBe('vault.example.com');
    expect(options.user.name).toBe('vault');
    expect(options.authenticatorSelection).toMatchObject({ residentKey: 'required', userVerification: 'required' });
    const res = await post('/api/auth/setup/verify', {
      token,
      challengeId,
      name: 'Laptop',
      response: { id: 'cred-1', challenge: options.challenge },
    });
    expect(res.statusCode).toBe(200);
    const c = setCookie(res);
    expect(c).toMatch(/HttpOnly/);
    expect(c).toMatch(/Secure/);
    expect(c).toMatch(/SameSite=Strict/);
    expect(c).toMatch(/Path=\//);
    expect(c).toMatch(new RegExp(`Max-Age=${14 * 86400}(;|$)`));
    const state = await send('GET', '/api/auth/state', cookiePair(res));
    expect(state.json()).toEqual({ authenticated: true, setupRequired: false, publicOrigin: ORIGIN });
    expect((await passkeys.list()).map((p) => p.name)).toEqual(['Laptop']);
  });

  it('the setup token can be used only once', async () => {
    const token = await setup.issue();
    const first = (await post('/api/auth/setup/options', { token })).json();
    await post('/api/auth/setup/verify', {
      token,
      challengeId: first.challengeId,
      name: 'A',
      response: { id: 'a', challenge: first.options.challenge },
    });
    expect((await post('/api/auth/setup/options', { token })).statusCode).toBe(403);
  });

  it('a failed verification does not burn the setup token', async () => {
    const token = await setup.issue();
    const o1 = (await post('/api/auth/setup/options', { token })).json();
    const bad = await post('/api/auth/setup/verify', {
      token,
      challengeId: o1.challengeId,
      name: 'A',
      response: { id: 'a', challenge: o1.options.challenge, ok: false },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.headers['set-cookie']).toBeUndefined();
    const o2 = (await post('/api/auth/setup/options', { token })).json();
    const good = await post('/api/auth/setup/verify', {
      token,
      challengeId: o2.challengeId,
      name: 'A',
      response: { id: 'a', challenge: o2.options.challenge },
    });
    expect(good.statusCode).toBe(200);
  });

  it('setup after an existing passkey without a CLI token → 403; with a new CLI token it works', async () => {
    await doSetup('cred-1');
    expect((await post('/api/auth/setup/options', {})).statusCode).toBe(403);
    expect((await post('/api/auth/setup/options', { token: 'guess' })).statusCode).toBe(403);
    await doSetup('cred-2', 'Handy'); // issues a token like `setup-link` would
    expect((await passkeys.list()).map((p) => p.id).sort()).toEqual(['cred-1', 'cred-2']);
  });

  it('excludes existing passkeys on registration', async () => {
    await doSetup('cred-1');
    const token = await setup.issue();
    const { options } = (await post('/api/auth/setup/options', { token })).json();
    expect(options.excludeCredentials.map((c: { id: string }) => c.id)).toEqual(['cred-1']);
  });

  it('keeps the same user id for every registration', async () => {
    const t1 = await setup.issue();
    const u1 = (await post('/api/auth/setup/options', { token: t1 })).json().options.user.id;
    const u2 = (await post('/api/auth/setup/options', { token: t1 })).json().options.user.id;
    expect(u1).toBe(u2);
  });
});

describe('login', () => {
  beforeEach(async () => {
    await doSetup('cred-1');
  });

  it('logs in with a valid assertion and sets the cookie; updates counter and lastUsed', async () => {
    clock += 5 * MIN;
    const res = await doLogin();
    expect(res.statusCode).toBe(200);
    expect(setCookie(res)).toMatch(/HttpOnly; Secure; SameSite=Strict|HttpOnly.*Secure.*SameSite=Strict/);
    const pk = (await passkeys.list())[0]!;
    expect(pk.counter).toBe(1);
    expect(pk.lastUsed).toBe(clock);
  });

  it('login options require user verification; every verification requires it', async () => {
    const { options } = (await loginOptions()).json();
    expect(options.userVerification).toBe('required');
    expect(options.rpId).toBe('vault.example.com');
    expect((await doLogin()).statusCode).toBe(200);
    expect(uvRequired.length).toBeGreaterThanOrEqual(2); // setup + login
    expect(uvRequired.every((v) => v === true)).toBe(true);
  });

  it('rejects a login without user verification (401) and a setup without it (400)', async () => {
    const { options, challengeId } = (await loginOptions()).json();
    const res = await post('/api/auth/login/verify', { challengeId, response: { id: 'cred-1', challenge: options.challenge, uv: false } });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'Anmeldung fehlgeschlagen', code: 'LOGIN_FAILED' });
    expect(res.headers['set-cookie']).toBeUndefined();
    const token = await setup.issue();
    const reg = (await post('/api/auth/setup/options', { token })).json();
    const bad = await post('/api/auth/setup/verify', {
      token,
      challengeId: reg.challengeId,
      name: 'x',
      response: { id: 'cred-9', challenge: reg.options.challenge, uv: false },
    });
    expect(bad.statusCode).toBe(400);
    expect(await passkeys.list()).toHaveLength(1);
  });

  it('rejects a reused challenge (400)', async () => {
    const { options, challengeId } = (await loginOptions()).json();
    const body = { challengeId, response: { id: 'cred-1', challenge: options.challenge } };
    expect((await post('/api/auth/login/verify', body)).statusCode).toBe(200);
    const again = await post('/api/auth/login/verify', body);
    expect(again.statusCode).toBe(400);
    expect(again.json().code).toBe('CHALLENGE');
    expect(again.headers['set-cookie']).toBeUndefined();
  });

  it('a challenge is single use even when the first attempt fails', async () => {
    const { options, challengeId } = (await loginOptions()).json();
    const bad = await post('/api/auth/login/verify', {
      challengeId,
      response: { id: 'cred-1', challenge: options.challenge, ok: false },
    });
    expect(bad.statusCode).toBe(401);
    const retry = await post('/api/auth/login/verify', {
      challengeId,
      response: { id: 'cred-1', challenge: options.challenge },
    });
    expect(retry.statusCode).toBe(400);
  });

  it('rejects an expired challenge (older than 5 min)', async () => {
    const { options, challengeId } = (await loginOptions()).json();
    clock += 5 * MIN + 1;
    const res = await post('/api/auth/login/verify', { challengeId, response: { id: 'cred-1', challenge: options.challenge } });
    expect(res.statusCode).toBe(400);
  });

  it('rejects an unknown credential and a registration challenge (401/400)', async () => {
    const { options, challengeId } = (await loginOptions()).json();
    const unknown = await post('/api/auth/login/verify', { challengeId, response: { id: 'nope', challenge: options.challenge } });
    expect(unknown.statusCode).toBe(401);
    const token = await setup.issue();
    const reg = (await post('/api/auth/setup/options', { token })).json();
    const cross = await post('/api/auth/login/verify', {
      challengeId: reg.challengeId,
      response: { id: 'cred-1', challenge: reg.options.challenge },
    });
    expect(cross.statusCode).toBe(400);
  });

  it('validates the request body (400)', async () => {
    const res = await post('/api/auth/login/verify', { challengeId: 5 });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: expect.any(String), code: 'BAD_REQUEST' });
  });
});

describe('rate limit', () => {
  it('the 11th login attempt per minute from one IP → 429', async () => {
    for (let i = 0; i < 10; i++) expect((await loginOptions()).statusCode).toBe(200);
    const res = await loginOptions();
    expect(res.statusCode).toBe(429);
    expect(res.json()).toEqual({ error: expect.any(String), code: 'RATE_LIMITED' });
    // Other IP is not affected.
    const other = await app.inject({
      method: 'POST',
      url: '/api/auth/login/options',
      payload: {},
      remoteAddress: '10.9.9.9',
      headers: { origin: ORIGIN },
    });
    expect(other.statusCode).toBe(200);
  });

  it('limits the verify routes too', async () => {
    for (let i = 0; i < 10; i++) await post('/api/auth/login/verify', { challengeId: 'x', response: { id: 'a' } });
    expect((await post('/api/auth/login/verify', { challengeId: 'x', response: { id: 'a' } })).statusCode).toBe(429);
    for (let i = 0; i < 10; i++) await post('/api/auth/setup/options', { token: 'x' });
    expect((await post('/api/auth/setup/options', { token: 'x' })).statusCode).toBe(429);
  });

  it('ignores CF-Connecting-IP and X-Forwarded-For without TRUST_PROXY', async () => {
    for (let i = 0; i < 10; i++) {
      await loginOptions({ 'cf-connecting-ip': `1.2.3.${i}`, 'x-forwarded-for': `5.6.7.${i}` });
    }
    expect((await loginOptions({ 'cf-connecting-ip': '9.9.9.9', 'x-forwarded-for': '8.8.8.8' })).statusCode).toBe(429);
  });

  it('ignores CF-Connecting-IP behind a trusted proxy unless TRUST_CF_CONNECTING_IP=true (RL-1)', async () => {
    await app.close();
    app = await makeApp({ TRUST_PROXY: '1' });
    for (let i = 0; i < 10; i++) {
      expect((await loginOptions({ 'x-forwarded-for': '3.3.3.3', 'cf-connecting-ip': `1.2.3.${i}` })).statusCode).toBe(200);
    }
    expect((await loginOptions({ 'x-forwarded-for': '3.3.3.3', 'cf-connecting-ip': '1.2.3.99' })).statusCode).toBe(429);
  });

  it('uses CF-Connecting-IP with TRUST_PROXY and TRUST_CF_CONNECTING_IP=true', async () => {
    await app.close();
    app = await makeApp({ TRUST_PROXY: 'true', TRUST_CF_CONNECTING_IP: 'true' });
    for (let i = 0; i < 10; i++) await loginOptions({ 'cf-connecting-ip': '1.1.1.1' });
    expect((await loginOptions({ 'cf-connecting-ip': '1.1.1.1' })).statusCode).toBe(429);
    expect((await loginOptions({ 'cf-connecting-ip': '2.2.2.2' })).statusCode).toBe(200);
  });

  it('uses X-Forwarded-For when TRUST_PROXY is set', async () => {
    await app.close();
    app = await makeApp({ TRUST_PROXY: '1' });
    // Hop count 1: only the address added by the nearest proxy counts; spoofed earlier entries do not.
    for (let i = 0; i < 10; i++) await loginOptions({ 'x-forwarded-for': `7.7.7.${i}, 3.3.3.3` });
    expect((await loginOptions({ 'x-forwarded-for': '3.3.3.3' })).statusCode).toBe(429);
    expect((await loginOptions({ 'x-forwarded-for': '4.4.4.4' })).statusCode).toBe(200);
  });
});

describe('session-protected routes', () => {
  it('require a session (401)', async () => {
    expect((await send('GET', '/api/auth/passkeys')).statusCode).toBe(401);
    expect((await send('GET', '/api/auth/sessions')).statusCode).toBe(401);
    expect((await send('GET', '/api/auth/passkeys', '__Host-vw_session=forged')).statusCode).toBe(401);
    expect((await send('GET', '/api/auth/passkeys', 'vw_session=forged')).statusCode).toBe(401);
    expect((await post('/api/auth/passkeys/options', {})).statusCode).toBe(401);
    expect((await post('/api/auth/passkeys/confirm/options', {})).statusCode).toBe(401);
    expect((await post('/api/auth/passkeys/confirm', { challengeId: 'x', response: {} })).statusCode).toBe(401);
  });

  it('refreshes the cookie Max-Age on authenticated requests', async () => {
    const cookie = await doSetup();
    const res = await send('GET', '/api/auth/passkeys', cookie);
    expect(res.statusCode).toBe(200);
    expect(setCookie(res)).toMatch(new RegExp(`Max-Age=${14 * 86400}`));
    expect(cookiePair(res)).toBe(cookie);
  });

  it('lists passkeys without their public keys', async () => {
    const cookie = await doSetup('cred-1', 'Laptop');
    const list = (await send('GET', '/api/auth/passkeys', cookie)).json();
    expect(list).toEqual([
      { id: 'cred-1', name: 'Laptop', transports: ['internal'], createdAt: clock, lastUsed: null },
    ]);
  });

  it('adds, renames and deletes passkeys; deleting the last one needs ?force=1 (409)', async () => {
    const cookie = await doSetup('cred-1');
    await confirm(cookie);
    const { options, challengeId } = (await post('/api/auth/passkeys/options', {}, { cookie })).json();
    expect(options.excludeCredentials.map((c: { id: string }) => c.id)).toEqual(['cred-1']);
    const added = await post(
      '/api/auth/passkeys',
      { challengeId, name: 'Handy', response: { id: 'cred-2', challenge: options.challenge } },
      { cookie },
    );
    expect(added.statusCode).toBe(200);
    expect(added.json()).toMatchObject({ id: 'cred-2', name: 'Handy' });

    expect((await send('PATCH', '/api/auth/passkeys/cred-2', cookie, { name: 'iPhone' })).statusCode).toBe(204);
    expect((await passkeys.list()).find((p) => p.id === 'cred-2')?.name).toBe('iPhone');
    expect((await send('PATCH', '/api/auth/passkeys/zzz', cookie, { name: 'x' })).json()).toEqual({
      error: 'Passkey nicht gefunden',
      code: 'PASSKEY_NOT_FOUND',
    });

    expect((await send('DELETE', '/api/auth/passkeys/cred-2', cookie)).statusCode).toBe(204);
    const last = await send('DELETE', '/api/auth/passkeys/cred-1', cookie);
    expect(last.statusCode).toBe(409);
    expect(last.json()).toEqual({ error: expect.any(String), code: 'LAST_PASSKEY' });
    expect(await passkeys.hasPasskeys()).toBe(true);
    expect((await send('DELETE', '/api/auth/passkeys/cred-1?force=1', cookie)).statusCode).toBe(204);
    expect(await passkeys.hasPasskeys()).toBe(false);
    expect((await send('DELETE', '/api/auth/passkeys/cred-1?force=1', cookie)).statusCode).toBe(404);
  });

  it('rejects registering the same credential twice', async () => {
    const cookie = await doSetup('cred-1');
    await confirm(cookie);
    const { options, challengeId } = (await post('/api/auth/passkeys/options', {}, { cookie })).json();
    const dup = await post(
      '/api/auth/passkeys',
      { challengeId, name: 'x', response: { id: 'cred-1', challenge: options.challenge } },
      { cookie },
    );
    expect(dup.statusCode).toBe(409);
    expect(dup.json().code).toBe('DUPLICATE');
    expect(await passkeys.list()).toHaveLength(1);
  });

  it('lists sessions, revokes one and revokes all others', async () => {
    const mine = await doSetup();
    const other1 = cookiePair(await doLogin());
    const other2 = cookiePair(await doLogin());
    const list = (await send('GET', '/api/auth/sessions', mine)).json() as { id: string; current: boolean }[];
    expect(list).toHaveLength(3);
    expect(list.filter((s) => s.current)).toHaveLength(1);
    expect(JSON.stringify(list)).not.toMatch(/tokenHash/);

    const target = list.find((s) => !s.current)!;
    expect((await send('DELETE', `/api/auth/sessions/${target.id}`, mine)).statusCode).toBe(204);
    expect((await send('DELETE', `/api/auth/sessions/${target.id}`, mine)).json()).toEqual({
      error: 'Sitzung nicht gefunden',
      code: 'SESSION_NOT_FOUND',
    });
    expect(await sessions.list()).toHaveLength(2);

    expect((await post('/api/auth/sessions/revoke-others', undefined, { cookie: mine })).statusCode).toBe(204);
    expect((await send('GET', '/api/auth/state', other1)).json().authenticated).toBe(false);
    expect((await send('GET', '/api/auth/state', other2)).json().authenticated).toBe(false);
    expect((await send('GET', '/api/auth/state', mine)).json().authenticated).toBe(true);
  });
});

describe('adding a passkey needs a confirmation with an existing one (step-up)', () => {
  const addOptions = (cookie: string) => post('/api/auth/passkeys/options', {}, { cookie });

  it('without confirmation: 403 with a German message', async () => {
    const cookie = await doSetup('cred-1');
    const res = await addOptions(cookie);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'Bitte zuerst mit einem vorhandenen Passkey bestätigen', code: 'STEP_UP' });
  });

  it('confirmation options require user verification; a failed or non-UV confirmation allows nothing', async () => {
    const cookie = await doSetup('cred-1');
    const { options } = (await post('/api/auth/passkeys/confirm/options', {}, { cookie })).json();
    expect(options.userVerification).toBe('required');
    expect((await confirm(cookie, 'cred-1', { uv: false })).statusCode).toBe(401);
    expect((await confirm(cookie, 'cred-1', { ok: false })).json()).toEqual({ error: 'Bestätigung fehlgeschlagen', code: 'CONFIRM_FAILED' });
    expect((await confirm(cookie, 'unbekannt')).statusCode).toBe(401);
    expect((await addOptions(cookie)).statusCode).toBe(403);
  });

  it('a confirmation is single use and bound to its session', async () => {
    const mine = await doSetup('cred-1');
    const other = cookiePair(await doLogin());
    expect((await confirm(mine)).statusCode).toBe(200);
    expect((await addOptions(other)).statusCode).toBe(403); // another session
    expect((await addOptions(mine)).statusCode).toBe(200);
    expect((await addOptions(mine)).statusCode).toBe(403); // used up
  });

  it('a confirmation challenge cannot be redeemed by another session or as login', async () => {
    const mine = await doSetup('cred-1');
    const other = cookiePair(await doLogin());
    const { options, challengeId } = (await post('/api/auth/passkeys/confirm/options', {}, { cookie: mine })).json();
    const stolen = await post('/api/auth/passkeys/confirm', { challengeId, response: { id: 'cred-1', challenge: options.challenge } }, { cookie: other });
    expect(stolen.statusCode).toBe(400);
    const o2 = (await post('/api/auth/passkeys/confirm/options', {}, { cookie: mine })).json();
    const asLogin = await post('/api/auth/login/verify', { challengeId: o2.challengeId, response: { id: 'cred-1', challenge: o2.options.challenge } });
    expect(asLogin.statusCode).toBe(400);
  });

  it('expires after 5 minutes', async () => {
    const cookie = await doSetup('cred-1');
    expect((await confirm(cookie)).statusCode).toBe(200);
    clock += 5 * MIN + 1;
    expect((await addOptions(cookie)).statusCode).toBe(403);
  });

  it('registration options from the step-up only verify in the same session', async () => {
    const mine = await doSetup('cred-1');
    const other = cookiePair(await doLogin());
    await confirm(mine);
    const { options, challengeId } = (await addOptions(mine)).json();
    const res = await post('/api/auth/passkeys', { challengeId, name: 'x', response: { id: 'cred-2', challenge: options.challenge } }, { cookie: other });
    expect(res.statusCode).toBe(400);
    expect(await passkeys.list()).toHaveLength(1);
  });

  it('a setup challenge cannot be used to add a passkey in a session', async () => {
    const cookie = await doSetup('cred-1');
    const token = await setup.issue();
    const reg = (await post('/api/auth/setup/options', { token })).json();
    const res = await post('/api/auth/passkeys', { challengeId: reg.challengeId, name: 'x', response: { id: 'cred-2', challenge: reg.options.challenge } }, { cookie });
    expect(res.statusCode).toBe(400);
  });
});

describe('session cookie name', () => {
  it('over https: __Host- prefix; the old vw_session cookie is accepted once and re-issued', async () => {
    const token = (await doSetup()).split('=')[1]!;
    const res = await send('GET', '/api/auth/passkeys', `vw_session=${token}`);
    expect(res.statusCode).toBe(200);
    const all = ([] as string[]).concat(res.headers['set-cookie'] ?? []);
    expect(all.find((c) => c.startsWith('__Host-vw_session='))).toMatch(new RegExp(`^__Host-vw_session=${token};.*Path=/`));
    expect(all.find((c) => c.startsWith('__Host-vw_session='))).not.toMatch(/Domain/i);
    expect(all.find((c) => c.startsWith('vw_session='))).toMatch(/^vw_session=;.*(Max-Age=0|Expires=Thu, 01 Jan 1970)/);
  });

  it('over http://localhost: plain vw_session', async () => {
    await app.close();
    app = await makeApp({ PUBLIC_URL: 'http://localhost:3090' });
    const res = await app.inject({ method: 'GET', url: '/api/auth/state' });
    expect(res.json().publicOrigin).toBe('http://localhost:3090');
    const token = await sessions.create({ userAgent: 't', ip: '127.0.0.1' });
    const ok = await app.inject({ method: 'GET', url: '/api/auth/passkeys', headers: { cookie: `vw_session=${token}` } });
    expect(ok.statusCode).toBe(200);
    expect(String(ok.headers['set-cookie'])).toMatch(/^vw_session=/);
    const prefixed = await app.inject({ method: 'GET', url: '/api/auth/passkeys', headers: { cookie: `__Host-vw_session=${token}` } });
    expect(prefixed.statusCode).toBe(401);
  });
});

describe('logout', () => {
  it('revokes the session and clears the cookie', async () => {
    const cookie = await doSetup();
    const res = await post('/api/auth/logout', undefined, { cookie });
    expect(res.statusCode).toBe(204);
    const c = setCookie(res);
    expect(c).toMatch(/^__Host-vw_session=;/);
    expect(c).toMatch(/Max-Age=0|Expires=Thu, 01 Jan 1970/);
    expect((await send('GET', '/api/auth/state', cookie)).json().authenticated).toBe(false);
    expect(await sessions.list()).toHaveLength(0);
  });

  it('works without a session', async () => {
    expect((await post('/api/auth/logout')).statusCode).toBe(204);
  });
});

describe('PasskeyService', () => {
  it('one client cannot evict another client\'s challenge (per-client bound)', async () => {
    await doSetup('cred-1');
    const owner = await passkeys.authenticationOptions('10.0.0.1');
    for (let i = 0; i < 2000; i++) await passkeys.authenticationOptions('6.6.6.6');
    expect(
      await passkeys.finishAuthentication(owner.challengeId, { id: 'cred-1', challenge: owner.options.challenge }),
    ).toBe(true);
  });

  it('keeps at most 20 open challenges per client (its oldest is dropped)', async () => {
    await doSetup('cred-1');
    const first = await passkeys.authenticationOptions('6.6.6.6');
    const second = await passkeys.authenticationOptions('6.6.6.6');
    for (let i = 0; i < 19; i++) await passkeys.authenticationOptions('6.6.6.6');
    await expect(
      passkeys.finishAuthentication(first.challengeId, { id: 'cred-1', challenge: first.options.challenge }),
    ).rejects.toMatchObject({ code: 'CHALLENGE' });
    expect(await passkeys.finishAuthentication(second.challengeId, { id: 'cred-1', challenge: second.options.challenge })).toBe(true);
  });

  it('stores passkeys in passkeys.json and implements PasskeyAdmin', async () => {
    await doSetup('cred-1');
    const raw = JSON.parse(await readFile(join(dataDir, 'passkeys.json'), 'utf8'));
    expect(raw.passkeys).toHaveLength(1);
    expect(raw.userId).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await passkeys.hasPasskeys()).toBe(true);
    await passkeys.clearPasskeys();
    expect(await passkeys.hasPasskeys()).toBe(false);
  });

  it('sees passkeys cleared by another process (CLI reset-passkeys)', async () => {
    const cookie = await doSetup('cred-1');
    const cli = await PasskeyService.open({ dataDir, rpId: config.rpId, origin: ORIGIN, verifier: fakeVerifier });
    await cli.clearPasskeys();
    expect((await app.inject({ method: 'GET', url: '/api/auth/state', headers: { cookie } })).json().setupRequired).toBe(
      true,
    );
    const { options, challengeId } = (await loginOptions()).json();
    const res = await post('/api/auth/login/verify', { challengeId, response: { id: 'cred-1', challenge: options.challenge } });
    expect(res.statusCode).toBe(401);
  });
});

describe('logging', () => {
  it('never logs cookies or tokens', async () => {
    await app.close();
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk, _enc, cb) {
        lines.push(String(chunk));
        cb();
      },
    });
    app = await makeApp({}, stream);
    const cookie = await doSetup();
    const token = cookie.split('=')[1]!;
    await send('GET', '/api/auth/passkeys', cookie);
    await post('/api/auth/logout', undefined, { cookie });
    const log = lines.join('');
    expect(log.length).toBeGreaterThan(0);
    expect(log).not.toContain(token);
  });
});

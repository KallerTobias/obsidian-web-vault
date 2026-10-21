import { createHash, randomBytes } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance, LightMyRequestResponse, RouteOptions } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PasskeyService } from '../../server/auth/passkeys';
import { SessionStore } from '../../server/auth/sessions';
import { SetupTokens } from '../../server/auth/setup-token';
import { loadConfig, type Config } from '../../server/config';
import { EventBus } from '../../server/events';
import { buildApp, type AppDeps } from '../../server/http/app';
import { SearchIndex } from '../../server/index/search';
import { VaultIndex } from '../../server/index/vault-index';
import { loadSettings } from '../../server/store/settings';
import { VaultFiles } from '../../server/vault/files';
import { VaultOps } from '../../server/vault/ops';
import { VaultPaths } from '../../server/vault/paths';
import { VaultWatcher } from '../../server/vault/watcher';

const ORIGIN = 'https://vault.example.com';
const sha = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');

let base: string;
let dataDir: string;
let vaultDir: string;
let config: Config;
let deps: AppDeps;
let app: FastifyInstance;
let routes: RouteOptions[];
let cookie: string;
let ownWrites: { path: string; version: string }[];
let watcher: VaultWatcher | undefined;
/** Number of currently active EventBus subscriptions. */
let activeSubs: number;

interface MakeOpts {
  env?: Record<string, string>;
  /** Real chokidar watcher instead of a recording marker. */
  watch?: boolean;
  heartbeatMs?: number;
  /** Extra async onRequest delay (simulates slow session validation). */
  slowHookMs?: number;
  /** Built web app directory to serve. */
  webDir?: string;
}

async function makeApp(opts: MakeOpts = {}): Promise<FastifyInstance> {
  config = loadConfig({ PUBLIC_URL: ORIGIN, DATA_DIR: dataDir, VAULT_DIR: vaultDir, ...opts.env });
  const sessions = await SessionStore.open({ dataDir, sessionDays: config.sessionDays });
  const paths = new VaultPaths(vaultDir, config.excludeGlobs, config.readonlyGlobs);
  const files = new VaultFiles(paths);
  const index = new VaultIndex();
  const search = new SearchIndex();
  const events = new EventBus();
  activeSubs = 0;
  const subscribe = events.subscribe.bind(events);
  events.subscribe = (fn) => {
    activeSubs++;
    const off = subscribe(fn);
    let done = false;
    return () => {
      if (!done) activeSubs--;
      done = true;
      return off();
    };
  };
  ownWrites = [];
  const recorder = {
    markOwnWrite: (path: string, version: string) => void ownWrites.push({ path, version }),
    markOwnMove() {},
    unmarkOwnMove() {},
  };
  let marker: AppDeps['watcher'] = recorder;
  if (opts.watch) {
    watcher = new VaultWatcher({ root: vaultDir, paths, files, index, search, bus: events });
    await watcher.start();
    marker = watcher;
  }
  deps = {
    config,
    sessions,
    setup: await SetupTokens.open({ dataDir }),
    passkeys: await PasskeyService.open({ dataDir, rpId: config.rpId, origin: config.publicUrl.origin }),
    paths,
    files,
    ops: new VaultOps({ paths, files, index, bus: events, watcher: marker }),
    index,
    search,
    events,
    settings: await loadSettings(dataDir, vaultDir),
    watcher: marker,
  };
  const a = buildApp(deps, {
    logger: false,
    ...(opts.heartbeatMs ? { sseHeartbeatMs: opts.heartbeatMs } : {}),
    ...(opts.webDir ? { webDir: opts.webDir } : {}),
  });
  routes = [];
  a.addHook('onRoute', (r) => void routes.push(r));
  if (opts.slowHookMs) a.addHook('onRequest', async () => void (await new Promise((r) => setTimeout(r, opts.slowHookMs))));
  await a.ready();
  cookie = `vw_session=${await sessions.create({ userAgent: 'test', ip: '127.0.0.1' })}`;
  return a;
}

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), 'vw-api-')));
  dataDir = join(base, 'data');
  vaultDir = join(base, 'vault');
  await mkdir(vaultDir, { recursive: true });
  watcher = undefined;
  app = await makeApp();
});
afterEach(async () => {
  const closing = app.close();
  // fetch (undici) leaves an extra keep-alive connection without a request after an abort;
  // the server's idle-connection cleanup does not see it, so tear everything down here.
  app.server.closeAllConnections();
  await closing;
  await watcher?.stop();
  await rm(base, { recursive: true, force: true });
});

const q = (p: string) => encodeURIComponent(p);
const get = (url: string, headers: Record<string, string> = {}) =>
  app.inject({ method: 'GET', url, headers: { cookie, ...headers } });
const send = (method: 'POST' | 'PUT' | 'DELETE', url: string, payload?: object) =>
  app.inject({ method, url, payload, headers: { cookie, origin: ORIGIN } });
const disk = (rel: string) => readFile(join(vaultDir, rel), 'utf8');
async function put(rel: string, content: string | Buffer): Promise<void> {
  await mkdir(join(vaultDir, rel, '..'), { recursive: true });
  await writeFile(join(vaultDir, rel), content);
}
const createNote = async (path: string, content: string) => {
  const res = await send('POST', '/api/note', { path, content });
  expect(res.statusCode).toBe(200);
  return res.json() as { path: string; version: string };
};

function multipart(parts: { name: string; value?: string; filename?: string; type?: string; data?: Buffer }[]) {
  const boundary = `----vw${randomBytes(8).toString('hex')}`;
  const chunks: Buffer[] = [];
  for (const p of parts) {
    let head = `--${boundary}\r\nContent-Disposition: form-data; name="${p.name}"`;
    if (p.filename !== undefined) head += `; filename="${p.filename}"\r\nContent-Type: ${p.type ?? 'application/octet-stream'}`;
    chunks.push(Buffer.from(`${head}\r\n\r\n`), p.data ?? Buffer.from(p.value ?? ''), Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { payload: Buffer.concat(chunks), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}
const upload = (parts: Parameters<typeof multipart>[0]) => {
  const m = multipart(parts);
  return app.inject({ method: 'POST', url: '/api/attachment', payload: m.payload, headers: { cookie, origin: ORIGIN, ...m.headers } });
};

describe('default deny', () => {
  it('every registered /api route except /api/auth/* and /api/health answers 401 without a session', async () => {
    const guarded = routes.filter((r) => r.url.startsWith('/api/') && !r.url.startsWith('/api/auth/') && r.url !== '/api/health');
    const keys = new Set(guarded.flatMap((r) => [r.method].flat().map((m) => `${m} ${r.url}`)));
    for (const k of [
      'GET /api/tree',
      'GET /api/note',
      'PUT /api/note',
      'POST /api/note',
      'POST /api/folder',
      'POST /api/rename',
      'GET /api/rename/affected',
      'DELETE /api/entry',
      'GET /api/file',
      'POST /api/attachment',
      'GET /api/backlinks',
      'GET /api/meta',
      'GET /api/resolve',
      'GET /api/lookup',
      'GET /api/search',
      'GET /api/tags',
      'GET /api/graph',
      'GET /api/events',
      'GET /api/changes',
      'GET /api/settings',
      'PUT /api/settings',
    ]) {
      expect(keys).toContain(k);
    }
    for (const key of keys) {
      const [method, url] = key.split(' ') as [string, string];
      const res = await app.inject({
        method: method as 'GET',
        url: `${url.replace(/:(\w+)/g, 'x')}?path=a.md&q=a&since=0&target=a&from=a.md`,
        headers: { origin: ORIGIN },
        ...(['POST', 'PUT'].includes(method) ? { payload: {} } : {}),
      });
      expect(res.statusCode, key).toBe(401);
      if (method !== 'HEAD') expect(res.json(), key).toEqual({ error: 'Nicht angemeldet' });
    }
  });

  it('also denies unknown /api paths and invalid cookies', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/gibtsnicht' })).statusCode).toBe(401);
    const bad = await app.inject({ method: 'GET', url: '/api/tree', headers: { cookie: 'vw_session=falsch' } });
    expect(bad.statusCode).toBe(401);
    expect((await get('/api/gibtsnicht')).statusCode).toBe(404);
  });

  it('leaves /api/health and /api/auth/state public', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/health' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/auth/state' })).statusCode).toBe(200);
  });
});

describe('notes', () => {
  it('reads a note with version and readonly flag', async () => {
    await put('A.md', 'Hallo');
    const res = await get(`/api/note?path=A.md`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ content: 'Hallo', version: sha('Hallo'), readonly: false });
  });

  it('refuses to serve a non-UTF-8 note for editing (415) and never overwrites it; /api/file still works', async () => {
    const latin1 = Buffer.from([0x47, 0x72, 0xfc, 0xdf, 0x65]);
    await put('Latin.md', latin1);
    const res = await get('/api/note?path=Latin.md');
    expect(res.statusCode).toBe(415);
    expect(res.json().error).toMatch(/nicht UTF-8/);
    const write = await send('PUT', '/api/note?path=Latin.md', { content: 'neu', baseVersion: sha(latin1) });
    expect(write.statusCode).toBe(415);
    expect((await readFile(join(vaultDir, 'Latin.md'))).equals(latin1)).toBe(true);
    const file = await get('/api/file?path=Latin.md');
    expect(file.statusCode).toBe(200);
    expect(file.rawPayload.equals(latin1)).toBe(true);
  });

  it('rejects traversal (400) and hides dot paths (404) without leaking server paths', async () => {
    await put('.git/config', 'secret');
    for (const p of ['../../etc/passwd', '/etc/passwd', 'a/../../x.md']) {
      const res = await get(`/api/note?path=${q(p)}`);
      expect(res.statusCode, p).toBe(400);
      expect(res.body).not.toContain(base);
    }
    for (const p of ['.git/config', '.obsidian/app.json', 'a/.hidden.md']) {
      const res = await get(`/api/note?path=${q(p)}`);
      expect(res.statusCode, p).toBe(404);
    }
    const missing = await get('/api/note?path=gibtsnicht.md');
    expect(missing.statusCode).toBe(404);
    expect(missing.body).not.toContain(base);
    await mkdir(join(vaultDir, 'Ordner'));
    expect((await get('/api/note?path=Ordner')).statusCode).toBe(400);
    expect((await get('/api/note')).statusCode).toBe(400);
    expect((await get(`/api/note?path=${'a'.repeat(1025)}`)).statusCode).toBe(400);
  });

  it('refuses to load non-text files (400) and files over 10 MB (413) as notes', async () => {
    await put('bild.png', randomBytes(10));
    expect((await get('/api/note?path=bild.png')).statusCode).toBe(400);
    await put('x.bin', 'x');
    expect((await get('/api/note?path=x.bin')).statusCode).toBe(400);
    await put('Riesig.md', Buffer.alloc(10 * 1024 * 1024 + 1, 'a'));
    expect((await get('/api/note?path=Riesig.md')).statusCode).toBe(413);
    await put('t.txt', 'text');
    expect((await get('/api/note?path=t.txt')).json().content).toBe('text');
  });

  it('writes with the matching baseVersion, marks the own write and publishes changed', async () => {
    await put('A.md', 'alt');
    const res = await send('PUT', '/api/note?path=A.md', { content: 'neu [[B]]', baseVersion: sha('alt') });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ version: sha('neu [[B]]') });
    expect(await disk('A.md')).toBe('neu [[B]]');
    expect(ownWrites).toEqual([{ path: 'A.md', version: sha('neu [[B]]') }]);
    expect(deps.events.since(0)).toMatchObject([{ type: 'changed', path: 'A.md', version: sha('neu [[B]]') }]);
    expect(deps.index.note('A.md')?.links.map((l) => l.target)).toEqual(['B']);
  });

  it('answers a conflicting PUT with 409 and the disk content, without writing', async () => {
    await put('A.md', 'extern geändert');
    const res = await send('PUT', '/api/note?path=A.md', { content: 'meins', baseVersion: sha('alt') });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({
      error: expect.any(String),
      diskContent: 'extern geändert',
      diskVersion: sha('extern geändert'),
    });
    expect(await disk('A.md')).toBe('extern geändert');
    const gone = await send('PUT', '/api/note?path=weg.md', { content: 'x', baseVersion: sha('x') });
    expect(gone.statusCode).toBe(409);
    expect(gone.json()).toMatchObject({ diskContent: null, diskVersion: null });
  });

  it('validates the PUT body', async () => {
    await put('A.md', 'a');
    expect((await send('PUT', '/api/note?path=A.md', { content: 'x' })).statusCode).toBe(400);
    expect((await send('PUT', '/api/note?path=A.md', { content: 5, baseVersion: sha('a') })).statusCode).toBe(400);
  });

  it('accepts note bodies up to 10 MB', async () => {
    await put('A.md', 'a');
    const big = 'x'.repeat(5 * 1024 * 1024);
    const res = await send('PUT', '/api/note?path=A.md', { content: big, baseVersion: sha('a') });
    expect(res.statusCode).toBe(200);
    const tooBig = await send('PUT', '/api/note?path=A.md', { content: 'x'.repeat(11 * 1024 * 1024), baseVersion: sha(big) });
    expect(tooBig.statusCode).toBe(413);
  });

  it('creates notes (409 with disk content if present) and publishes created', async () => {
    const res = await send('POST', '/api/note', { path: 'Neu/N.md', content: '# N' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ path: 'Neu/N.md', version: sha('# N') });
    expect(await disk('Neu/N.md')).toBe('# N');
    expect(deps.events.since(0)).toMatchObject([{ type: 'created', path: 'Neu/N.md' }]);
    const again = await send('POST', '/api/note', { path: 'Neu/N.md', content: 'anders' });
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ diskContent: '# N', diskVersion: sha('# N') });
    expect((await send('POST', '/api/note', { path: '.obsidian/x.md', content: '' })).statusCode).toBe(404);
  });

  it('refuses writes into READONLY_PATHS (403) and reports readonly on read', async () => {
    await app.close();
    app = await makeApp({ env: { READONLY_PATHS: 'Archiv/**' } });
    await put('Archiv/A.md', 'a');
    expect((await get('/api/note?path=Archiv/A.md')).json().readonly).toBe(true);
    const res = await send('PUT', '/api/note?path=Archiv/A.md', { content: 'b', baseVersion: sha('a') });
    expect(res.statusCode).toBe(403);
    expect((await send('POST', '/api/note', { path: 'Archiv/B.md', content: '' })).statusCode).toBe(403);
  });

  it('hides EXCLUDE_PATHS (404)', async () => {
    await app.close();
    app = await makeApp({ env: { EXCLUDE_PATHS: 'Privat/**' } });
    await put('Privat/A.md', 'a');
    expect((await get('/api/note?path=Privat/A.md')).statusCode).toBe(404);
  });

  it('reads, writes and renames paths with dashes, spaces, #, %, ( ) and unicode', async () => {
    const a = 'Homelab/Intern/Archiv/YouTube – Scgw1H4K-Ng.md';
    const b = 'a/b (1) #x%.md';
    await put(a, 'Video');
    await put(b, 'Sonder [[YouTube – Scgw1H4K-Ng]]');
    for (const [p, content] of [
      [a, 'Video'],
      [b, 'Sonder [[YouTube – Scgw1H4K-Ng]]'],
    ] as const) {
      const r = await get(`/api/note?path=${q(p)}`);
      expect(r.statusCode, p).toBe(200);
      expect(r.json().content).toBe(content);
      const w = await send('PUT', `/api/note?path=${q(p)}`, { content: `${content}!`, baseVersion: sha(content) });
      expect(w.statusCode, p).toBe(200);
      expect(await disk(p)).toBe(`${content}!`);
    }
    // Index the notes so the rename can update the link.
    await app.close();
    app = await makeApp({ watch: true });
    const to = 'c (2) #y – ü/b (1) #x%.md'; // moved; its existing name with # stays allowed
    const ren = await send('POST', '/api/rename', { from: a, to: 'Homelab/YouTube – neu (1) %.md', updateLinks: true });
    expect(ren.statusCode).toBe(200);
    expect(ren.json()).toMatchObject({ moved: [{ from: a, to: 'Homelab/YouTube – neu (1) %.md' }], updated: [b] });
    expect(await disk(b)).toContain('[[YouTube – neu (1) %]]');
    const ren2 = await send('POST', '/api/rename', { from: b, to, updateLinks: false });
    expect(ren2.statusCode).toBe(200);
    expect((await get(`/api/note?path=${q(to)}`)).json().content).toContain('Sonder');
  });
});

describe('folders, rename, trash', () => {
  it('creates folders and publishes created once', async () => {
    const res = await send('POST', '/api/folder', { path: 'X/Y' });
    expect(res.statusCode).toBe(200);
    expect((await readdir(join(vaultDir, 'X'))).includes('Y')).toBe(true);
    expect(deps.events.since(0)).toMatchObject([{ type: 'created', path: 'X/Y' }]);
    expect((await send('POST', '/api/folder', { path: 'X/Y' })).statusCode).toBe(200);
    expect(deps.events.seq).toBe(1);
    expect((await send('POST', '/api/folder', { path: '.trash/x' })).statusCode).toBe(404);
    expect((await send('POST', '/api/folder', { path: '' })).statusCode).toBe(400);
    await put('Datei.md', '');
    expect((await send('POST', '/api/folder', { path: 'Datei.md' })).statusCode).toBe(409);
  });

  it('maps rename errors to clean 400/404/409 responses', async () => {
    await put('Ordner/A.md', 'a');
    await put('B.md', 'b');
    const self = await send('POST', '/api/rename', { from: 'Ordner', to: 'Ordner/Unter', updateLinks: true });
    expect(self.statusCode).toBe(400);
    expect(self.json().error).toMatch(/sich selbst/);
    const exists = await send('POST', '/api/rename', { from: 'Ordner/A.md', to: 'B.md', updateLinks: true });
    expect(exists.statusCode).toBe(409);
    expect(Object.keys(exists.json())).toEqual(['error']);
    const underFile = await send('POST', '/api/rename', { from: 'Ordner/A.md', to: 'B.md/A.md', updateLinks: true });
    expect([400, 409]).toContain(underFile.statusCode);
    expect(underFile.body).not.toContain(base);
    const missing = await send('POST', '/api/rename', { from: 'fehlt.md', to: 'x.md', updateLinks: true });
    expect(missing.statusCode).toBe(404);
    expect(missing.body).not.toContain(base);
    expect((await send('POST', '/api/rename', { from: 'B.md', to: 'C.md' })).statusCode).toBe(400);
    expect(await disk('Ordner/A.md')).toBe('a');
  });

  describe('names that would break wiki links or are invalid on other systems', () => {
    const BAD = ['a#b', 'a^b', 'a[b', 'a]b', 'a|b', 'a:b', 'a*b', 'a?b', 'a"b', 'a<b', 'a>b', 'a\\b', 'a\u0001b'];

    it.each(BAD)('POST /api/note and /api/folder refuse a new name like %j', async (bad) => {
      const note = await send('POST', '/api/note', { path: `Ordner/${bad}.md`, content: '' });
      expect(note.statusCode).toBe(400);
      expect(note.json().error).toMatch(/darf keines dieser Zeichen enthalten/);
      const folder = await send('POST', '/api/folder', { path: `Ordner/${bad}` });
      expect(folder.statusCode).toBe(400);
      expect(await readdir(vaultDir)).toEqual([]);
    });

    it.each(BAD)('POST /api/note and /api/folder refuse a new parent folder like %j', async (bad) => {
      const note = await send('POST', '/api/note', { path: `${bad}/Neu/x.md`, content: '' });
      expect(note.statusCode).toBe(400);
      expect(note.json().error).toMatch(/darf keines dieser Zeichen enthalten/);
      const folder = await send('POST', '/api/folder', { path: `Neu/${bad}/Unter` });
      expect(folder.statusCode).toBe(400);
      expect(await readdir(vaultDir)).toEqual([]);
    });

    it('allows creating entries inside an existing folder whose name has such characters', async () => {
      await put('Projekt #1/alt.md', 'a');
      expect((await send('POST', '/api/note', { path: 'Projekt #1/Neu.md', content: '' })).statusCode).toBe(200);
      expect((await send('POST', '/api/folder', { path: 'Projekt #1/Unter' })).statusCode).toBe(200);
    });

    it.each(BAD)('POST /api/rename refuses changing a name to one like %j', async (bad) => {
      await put('A.md', 'a');
      await put('Ordner/x.md', 'x');
      const file = await send('POST', '/api/rename', { from: 'A.md', to: `${bad}.md`, updateLinks: true });
      expect(file.statusCode).toBe(400);
      expect(file.json().error).toMatch(/darf keines dieser Zeichen enthalten/);
      const folder = await send('POST', '/api/rename', { from: 'Ordner', to: bad, updateLinks: true });
      expect(folder.statusCode).toBe(400);
      expect(await disk('A.md')).toBe('a');
      expect(await disk('Ordner/x.md')).toBe('x');
    });

    it('allows moving an entry whose existing name already has such characters', async () => {
      await put('Projekte/Notiz #1.md', 'n');
      await put('Alt [x]/a.md', 'a');
      const note = await send('POST', '/api/rename', { from: 'Projekte/Notiz #1.md', to: 'Archiv – ü/Notiz #1.md', updateLinks: true });
      expect(note.statusCode).toBe(200);
      expect(await disk('Archiv – ü/Notiz #1.md')).toBe('n');
      const folder = await send('POST', '/api/rename', { from: 'Alt [x]', to: 'Archiv – ü/Alt [x]', updateLinks: true });
      expect(folder.statusCode).toBe(200);
      expect(await disk('Archiv – ü/Alt [x]/a.md')).toBe('a');
      // Changing such a name is a new name: it must be valid.
      const renamed = await send('POST', '/api/rename', { from: 'Archiv – ü/Notiz #1.md', to: 'Archiv – ü/Notiz #2.md', updateLinks: true });
      expect(renamed.statusCode).toBe(400);
      const fixed = await send('POST', '/api/rename', { from: 'Archiv – ü/Notiz #1.md', to: 'Archiv – ü/Notiz 1.md', updateLinks: true });
      expect(fixed.statusCode).toBe(200);
    });
  });

  it('lists notes affected by a rename', async () => {
    await createNote('Ziel.md', 'z');
    await createNote('Q1.md', '[[Ziel]]');
    await createNote('Q2.md', '[x](Ziel.md)');
    const res = await get('/api/rename/affected?path=Ziel.md');
    expect(res.json()).toEqual({ count: 2, paths: ['Q1.md', 'Q2.md'] });
  });

  it('moves entries into .trash', async () => {
    await createNote('Weg.md', 'w');
    const res = await send('DELETE', '/api/entry?path=Weg.md');
    expect(res.statusCode).toBe(204);
    expect(await disk('.trash/Weg.md')).toBe('w');
    expect((await send('DELETE', '/api/entry?path=Weg.md')).statusCode).toBe(404);
    expect((await send('DELETE', '/api/entry?path=')).statusCode).toBe(400);
  });
});

describe('GET /api/file', () => {
  it('serves images inline with type, length and caching headers', async () => {
    const png = randomBytes(100);
    await put('Bilder/Foto 1.png', png);
    const res = await get(`/api/file?path=${q('Bilder/Foto 1.png')}`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.headers['content-length']).toBe('100');
    expect(res.headers['cache-control']).toBe('private, no-cache');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(String(res.headers['content-disposition'])).toMatch(/^inline; filename="Foto 1.png"; filename\*=UTF-8''Foto%201.png$/);
    expect(res.rawPayload.equals(png)).toBe(true);
  });

  it('serves HTML and unknown types as attachment with an RFC 5987 file name', async () => {
    await put('Seite – ü.html', '<script>alert(1)</script>');
    const res = await get(`/api/file?path=${q('Seite – ü.html')}`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/html/);
    expect(res.headers['content-disposition']).toBe(
      `attachment; filename="Seite _ _.html"; filename*=UTF-8''${encodeURIComponent('Seite – ü.html')}`,
    );
    await put('x.bin', 'x');
    expect((await get('/api/file?path=x.bin')).headers['content-disposition']).toMatch(/^attachment;/);
    await put('n.md', '# n');
    expect((await get('/api/file?path=n.md')).headers['content-disposition']).toMatch(/^attachment;/);
  });

  it('sandboxes SVG and serves PDF/audio/video inline', async () => {
    await put('a.svg', '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    const svg = await get('/api/file?path=a.svg');
    expect(svg.headers['content-type']).toBe('image/svg+xml');
    expect(String(svg.headers['content-security-policy'])).toMatch(/(^|;\s*)sandbox(;|$)/);
    expect(svg.headers['content-disposition']).toMatch(/^inline;/);
    for (const f of ['d.pdf', 's.mp3', 'v.mp4']) {
      await put(f, 'x');
      expect((await get(`/api/file?path=${f}`)).headers['content-disposition'], f).toMatch(/^inline;/);
    }
  });

  it('lets the app embed PDFs (own origin only); everything else stays unframeable', async () => {
    await put('d.pdf', '%PDF-1.4');
    const pdf = String((await get('/api/file?path=d.pdf')).headers['content-security-policy']);
    expect(pdf).toBe("frame-ancestors 'self'");
    await put('b.png', 'x');
    expect(String((await get('/api/file?path=b.png')).headers['content-security-policy'])).toMatch(/frame-ancestors 'none'/);
  });

  it('supports single byte ranges', async () => {
    await put('v.mp4', '0123456789');
    const res = await get('/api/file?path=v.mp4', { range: 'bytes=2-5' });
    expect(res.statusCode).toBe(206);
    expect(res.headers['content-range']).toBe('bytes 2-5/10');
    expect(res.headers['content-length']).toBe('4');
    expect(res.body).toBe('2345');
    expect((await get('/api/file?path=v.mp4', { range: 'bytes=-3' })).body).toBe('789');
    expect((await get('/api/file?path=v.mp4', { range: 'bytes=7-' })).body).toBe('789');
    const bad = await get('/api/file?path=v.mp4', { range: 'bytes=20-30' });
    expect(bad.statusCode).toBe(416);
    expect(bad.headers['content-range']).toBe('bytes */10');
    expect(bad.headers['content-disposition']).toBeUndefined();
    expect(bad.json()).toEqual({ error: expect.any(String) });
    expect((await get('/api/file?path=v.mp4')).headers['accept-ranges']).toBe('bytes');
  });

  it('refuses hidden paths, folders and missing files', async () => {
    await put('.obsidian/app.json', '{}');
    expect((await get('/api/file?path=.obsidian/app.json')).statusCode).toBe(404);
    await mkdir(join(vaultDir, 'Ordner'));
    expect((await get('/api/file?path=Ordner')).statusCode).toBe(400);
    expect((await get('/api/file?path=fehlt.png')).statusCode).toBe(404);
  });
});

describe('POST /api/attachment', () => {
  const setFolder = async (attachmentFolder: string) => {
    const res = await send('PUT', '/api/settings', { attachmentFolder });
    expect(res.statusCode).toBe(200);
  };

  it('stores into the attachment folder and makes names unique', async () => {
    await setFolder('Anhänge');
    const file = { name: 'file', filename: 'bild.png', type: 'image/png', data: Buffer.from('png') };
    const first = await upload([{ name: 'notePath', value: 'Notizen/A.md' }, file]);
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ path: 'Anhänge/bild.png' });
    const second = await upload([file, { name: 'notePath', value: 'Notizen/A.md' }]);
    expect(second.json()).toEqual({ path: 'Anhänge/bild 1.png' });
    expect(await disk('Anhänge/bild 1.png')).toBe('png');
    expect(ownWrites.map((w) => w.path)).toEqual(['Anhänge/bild.png', 'Anhänge/bild 1.png']);
    expect(deps.events.since(0)).toMatchObject([
      { type: 'created', path: 'Anhänge/bild.png', version: sha('png') },
      { type: 'created', path: 'Anhänge/bild 1.png' },
    ]);
    expect(deps.index.lookup().byPath.get('anhänge/bild.png')).toBe('Anhänge/bild.png');
  });

  it('resolves vault root, "./" and "./sub" relative to the note', async () => {
    const file = { name: 'file', filename: 'x.pdf', data: Buffer.from('pdf') };
    await setFolder('');
    expect((await upload([{ name: 'notePath', value: 'N/A.md' }, file])).json()).toEqual({ path: 'x.pdf' });
    await setFolder('./');
    expect((await upload([{ name: 'notePath', value: 'N/A.md' }, file])).json()).toEqual({ path: 'N/x.pdf' });
    await setFolder('./Anhang');
    expect((await upload([{ name: 'notePath', value: 'N/A.md' }, file])).json()).toEqual({ path: 'N/Anhang/x.pdf' });
    expect((await upload([{ name: 'notePath', value: 'A.md' }, file])).json()).toEqual({ path: 'Anhang/x.pdf' });
  });

  it('names pasted images "Pasted image YYYYMMDDHHmmss.png"', async () => {
    const res = await upload([
      { name: 'notePath', value: 'A.md' },
      { name: 'pasted', value: '1' },
      { name: 'file', filename: 'image.png', type: 'image/png', data: Buffer.from('p') },
    ]);
    expect(res.json().path).toMatch(/^Pasted image \d{14}\.png$/);
  });

  it('sanitizes file names', async () => {
    const res = await upload([{ name: 'file', filename: 'a:b*c?<d>|e.png', data: Buffer.from('x') }]);
    expect(res.json()).toEqual({ path: 'abcde.png' });
    const dots = await upload([{ name: 'file', filename: '..hidden.txt', data: Buffer.from('x') }]);
    expect(dots.json()).toEqual({ path: 'hidden.txt' });
    const empty = await upload([{ name: 'file', filename: '???.png', data: Buffer.from('x') }]);
    expect(empty.json()).toEqual({ path: 'Anhang.png' });
  });

  it('replaces characters that break wiki links (# ^ [ ]) in upload names with "-"', async () => {
    const res = await upload([{ name: 'file', filename: 'Scan #3 [final]^2.png', data: Buffer.from('x') }]);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ path: 'Scan -3 -final--2.png' });
  });

  it('refuses hidden, excluded and readonly targets and missing files', async () => {
    await app.close();
    app = await makeApp({ env: { READONLY_PATHS: 'Archiv/**', EXCLUDE_PATHS: 'Privat/**' } });
    const file = { name: 'file', filename: 'x.png', data: Buffer.from('x') };
    await setFolder('Archiv');
    expect((await upload([file])).statusCode).toBe(403);
    await setFolder('Privat');
    expect((await upload([file])).statusCode).toBe(404);
    await setFolder('.obsidian');
    expect((await upload([file])).statusCode).toBe(404);
    await setFolder('');
    expect((await upload([{ name: 'notePath', value: 'A.md' }])).statusCode).toBe(400);
    expect((await upload([{ name: 'notePath', value: '../A.md' }, file])).statusCode).toBe(400);
  });

  it('limits uploads to 50 MB; no temp file remains', async () => {
    const res = await upload([{ name: 'file', filename: 'gross.bin', data: Buffer.alloc(50 * 1024 * 1024 + 1) }]);
    expect(res.statusCode).toBe(413);
    expect(await readdir(vaultDir)).toEqual([]);
  });

  it('streams a large upload to disk byte-exact, leaves no temp file, reports the version', async () => {
    const data = randomBytes(20 * 1024 * 1024);
    const res = await upload([{ name: 'notePath', value: 'A.md' }, { name: 'file', filename: 'video.mp4', data }]);
    expect(res.json()).toEqual({ path: 'video.mp4' });
    expect((await readFile(join(vaultDir, 'video.mp4'))).equals(data)).toBe(true);
    expect(await readdir(vaultDir)).toEqual(['video.mp4']);
    expect(deps.events.since(0)).toMatchObject([{ type: 'created', path: 'video.mp4', version: sha(data) }]);
  });

  it('an uploaded .md is indexed with its text', async () => {
    const res = await upload([{ name: 'file', filename: 'Import.md', data: Buffer.from('Hallo [[Ziel]] #neu') }]);
    expect(res.json()).toEqual({ path: 'Import.md' });
    expect(deps.index.note('Import.md')?.tags.map((t) => t.tag)).toEqual(['neu']);
  });
});

describe('index routes', () => {
  beforeEach(async () => {
    await createNote('Ziel.md', '---\naliases: [Z]\n---\n# Kopf\nInhalt #projekt/a');
    await createNote('Quelle.md', 'Siehe [[Ziel]] und Ziel #projekt');
    await createNote('Erwähnung.md', 'Ziel ohne Link');
  });

  it('GET /api/backlinks', async () => {
    const res = await get('/api/backlinks?path=Ziel.md');
    expect(res.json()).toEqual({
      linked: [{ source: 'Quelle.md', contexts: [{ line: 0, text: 'Siehe [[Ziel]] und Ziel #projekt' }] }],
      unlinked: [{ source: 'Erwähnung.md', contexts: [{ line: 0, text: 'Ziel ohne Link' }] }],
    });
  });

  it('GET /api/meta (404 for unknown notes)', async () => {
    const res = await get('/api/meta?path=Ziel.md');
    expect(res.json()).toMatchObject({ path: 'Ziel.md', aliases: ['Z'], headings: [{ text: 'Kopf' }] });
    expect((await get('/api/meta?path=fehlt.md')).statusCode).toBe(404);
  });

  it('GET /api/resolve', async () => {
    expect((await get('/api/resolve?target=ziel&from=Quelle.md')).json()).toEqual({ path: 'Ziel.md' });
    expect((await get('/api/resolve?target=nix&from=Quelle.md')).json()).toEqual({ path: null });
  });

  it('GET /api/lookup', async () => {
    const res = await get('/api/lookup');
    expect(res.json()).toContainEqual({ path: 'Ziel.md', name: 'Ziel', aliases: ['Z'], headings: [{ level: 1, text: 'Kopf' }] });
    expect(res.json()).toHaveLength(3);
  });

  it('GET /api/search', async () => {
    const res = await get('/api/search?q=Inhalt&limit=5');
    expect(res.json().map((h: { path: string }) => h.path)).toEqual(['Ziel.md']);
    expect((await get('/api/search?q=x&limit=abc')).statusCode).toBe(400);
  });

  it('GET /api/tags (without "#")', async () => {
    expect((await get('/api/tags')).json()).toEqual([
      { tag: 'projekt', count: 2 },
      { tag: 'projekt/a', count: 1 },
    ]);
  });

  it('GET /api/graph and GET /api/tree', async () => {
    const graph = (await get('/api/graph')).json();
    expect(graph.links).toContainEqual({ source: 'Quelle.md', target: 'Ziel.md' });
    const tree = (await get('/api/tree')).json();
    expect(tree.children.map((c: { path: string }) => c.path)).toEqual(['Erwähnung.md', 'Quelle.md', 'Ziel.md']);
  });
});

describe('settings', () => {
  it('answers store errors (DATA_DIR) with a logged 500, not a vault status', async () => {
    const file = join(dataDir, 'settings.json');
    await rm(file, { force: true });
    await writeFile(file, '{}');
    await chmod(file, 0);
    const res = await get('/api/settings');
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: 'Interner Fehler' });
    await chmod(file, 0o600);
  });

  it('GET returns the settings, PUT merges and returns the stored settings', async () => {
    expect((await get('/api/settings')).json()).toMatchObject({ attachmentFolder: '', theme: 'system' });
    const res = await send('PUT', '/api/settings', { theme: 'dark', graph: { repel: 2 }, dailyNotes: { folder: 'Tage' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ theme: 'dark', graph: { repel: 2, mode: '2d' }, dailyNotes: { folder: 'Tage', format: 'YYYY-MM-DD' } });
    expect((await get('/api/settings')).json()).toEqual(res.json());
  });

  it('rejects unknown keys and wrong types', async () => {
    for (const body of [{ bogus: 1 }, { theme: 'pink' }, { graph: { repel: 'x' } }, { graph: { extra: 1 } }, { attachmentFolder: 3 }]) {
      expect((await send('PUT', '/api/settings', body)).statusCode, JSON.stringify(body)).toBe(400);
    }
    expect((await get('/api/settings')).json().theme).toBe('system');
  });
});

describe('GET /api/changes', () => {
  it('returns events after writes, resync on gaps and unknown future seqs', async () => {
    await createNote('A.md', 'a');
    const res = await get('/api/changes?since=0');
    expect(res.json()).toMatchObject({ seq: 1, events: [{ seq: 1, type: 'created', path: 'A.md' }] });
    expect((await get('/api/changes?since=1')).json()).toEqual({ seq: 1, events: [] });
    expect((await get('/api/changes?since=99')).json()).toEqual({ resync: true, seq: 1 });
    for (let i = 0; i < 1001; i++) deps.events.publish({ type: 'changed', path: 'A.md' });
    expect((await get('/api/changes?since=0')).json()).toEqual({ resync: true, seq: 1002 });
    expect((await get('/api/changes?since=x')).statusCode).toBe(400);
    expect((await get('/api/changes')).statusCode).toBe(400);
  });
});

describe('SSE /api/events', () => {
  let url: string;

  async function listen(opts: MakeOpts) {
    await app.close();
    app = await makeApp(opts);
    const addr = await app.listen({ host: '127.0.0.1', port: 0 });
    url = `${addr}/api/events`;
  }

  /** Opens the stream and reads until `until` matches the received text. */
  async function open(headers: Record<string, string> = {}) {
    const ctrl = new AbortController();
    const res = await fetch(url, { headers: { cookie, ...headers }, signal: ctrl.signal });
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let text = '';
    const until = async (re: RegExp, ms = 5000) => {
      const end = Date.now() + ms;
      while (!re.test(text)) {
        if (Date.now() > end) throw new Error(`Timeout, erhalten: ${text}`);
        const { value, done } = await reader.read();
        if (done) throw new Error(`Stream beendet, erhalten: ${text}`);
        text += dec.decode(value, { stream: true });
      }
      return text;
    };
    return { res, until, close: () => ctrl.abort(), text: () => text };
  }

  const waitFor = async (cond: () => boolean, ms = 3000) => {
    const end = Date.now() + ms;
    while (!cond()) {
      if (Date.now() > end) throw new Error('Timeout');
      await new Promise((r) => setTimeout(r, 20));
    }
  };

  it('allows at most 10 open streams per session (429), a closed one frees its slot', async () => {
    await listen({});
    const streams = [];
    for (let i = 0; i < 10; i++) {
      const s = await open();
      await s.until(/event: ready/);
      streams.push(s);
    }
    const over = await fetch(url, { headers: { cookie } });
    expect(over.status).toBe(429);
    expect(await over.json()).toEqual({ error: expect.stringMatching(/Zu viele offene Verbindungen/) });
    // another session is not affected
    const other = `vw_session=${await deps.sessions.create({ userAgent: 'x', ip: '127.0.0.1' })}`;
    const s2 = await open({ cookie: other });
    await s2.until(/event: ready/);
    s2.close();
    streams.pop()!.close();
    await waitFor(() => activeSubs === 9);
    const again = await open();
    await again.until(/event: ready/);
    again.close();
    for (const s of streams) s.close();
  });

  it('streams changed after an external write, with ids; unsubscribes on close', async () => {
    await put('A.md', 'a');
    await listen({ watch: true });
    const s = await open();
    expect(s.res.status).toBe(200);
    expect(s.res.headers.get('content-type')).toMatch(/^text\/event-stream/);
    expect(s.res.headers.get('cache-control')).toBe('no-cache');
    expect(s.res.headers.get('x-accel-buffering')).toBe('no');
    await s.until(/event: ready\n/);
    expect(activeSubs).toBe(1);
    await writeFile(join(vaultDir, 'A.md'), 'extern');
    const text = await s.until(/event: changed\n/);
    expect(text).toMatch(/id: 1\nevent: changed\ndata: \{[^\n]*"path":"A.md"/);
    s.close();
    await waitFor(() => activeSubs === 0);
  });

  it('replays from Last-Event-ID and sends resync on gaps', async () => {
    await listen({});
    deps.events.publish({ type: 'created', path: 'A.md' });
    deps.events.publish({ type: 'changed', path: 'A.md' });
    const s = await open({ 'last-event-id': '1' });
    const text = await s.until(/id: 2\n/);
    expect(text).not.toMatch(/id: 1\n/);
    s.close();
    for (let i = 0; i < 1001; i++) deps.events.publish({ type: 'changed', path: 'A.md' });
    const g = await open({ 'last-event-id': '0' });
    expect(await g.until(/event: resync\n/)).toMatch(/event: resync\n/);
    g.close();
    const f = await open({ 'last-event-id': '99999' });
    await f.until(/event: resync\n/);
    f.close();
    await waitFor(() => activeSubs === 0);
  });

  it('sends heartbeats and requires a session', async () => {
    await listen({ heartbeatMs: 50 });
    const s = await open();
    await s.until(/: ping\n\n/);
    s.close();
    const res = await fetch(url);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Nicht angemeldet' });
    await waitFor(() => activeSubs === 0);
  });

  it('does not leak a subscription when the client aborts during slow request hooks', async () => {
    await listen({ slowHookMs: 200 });
    const port = (app.server.address() as net.AddressInfo).port;
    const sock = net.connect(port, '127.0.0.1', () => {
      sock.write(`GET /api/events HTTP/1.1\r\nHost: x\r\nCookie: ${cookie}\r\n\r\n`);
      setTimeout(() => sock.destroy(), 50);
    });
    await new Promise((r) => setTimeout(r, 600));
    expect(activeSubs).toBe(0);
  });

  it('ends the stream when the session is revoked', async () => {
    await listen({ heartbeatMs: 50 });
    const s = await open();
    await s.until(/event: ready\n/);
    await deps.sessions.revokeAll();
    await expect(s.until(/never/)).rejects.toThrow(/Stream beendet/);
    expect(activeSubs).toBe(0);
  });

  it('ends open streams when the app closes', async () => {
    await listen({});
    const s = await open();
    await s.until(/event: ready\n/);
    await app.close();
    expect(activeSubs).toBe(0);
    s.close();
  });
});

describe('web app (static files + SPA fallback)', () => {
  const html = '<!doctype html><div id="app"></div><script type="module" src="/assets/index-abc.js"></script>';
  let webDir: string;

  beforeEach(async () => {
    webDir = join(base, 'web');
    await mkdir(join(webDir, 'assets'), { recursive: true });
    await writeFile(join(webDir, 'index.html'), html);
    await writeFile(join(webDir, 'assets', 'index-abc.js'), 'console.log(1)');
    await app.close();
    app = await makeApp({ webDir });
  });
  const anon = (url: string, accept = 'text/html,application/xhtml+xml') =>
    app.inject({ method: 'GET', url, headers: { accept } });

  it('serves index.html at / without a session, revalidated, with CSP', async () => {
    const res = await anon('/');
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe(html);
    expect(res.headers['content-type']).toMatch(/^text\/html/);
    expect(res.headers['cache-control']).toBe('no-cache');
    expect(res.headers['content-security-policy']).toContain("script-src 'self'");
  });

  it('serves hashed assets with a long immutable cache', async () => {
    const res = await anon('/assets/index-abc.js', '*/*');
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('console.log(1)');
    expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable');
  });

  it('answers client-side routes with index.html', async () => {
    for (const url of ['/setup', '/Ordner/Notiz%20(1).md?x=1']) {
      const res = await anon(url);
      expect(res.statusCode, url).toBe(200);
      expect(res.body).toBe(html);
      expect(res.headers['cache-control']).toBe('no-cache');
      expect(res.headers['content-security-policy']).toContain("script-src 'self'");
    }
  });

  it('keeps unknown /api URLs as JSON errors (401 without session, 404 with)', async () => {
    const res = await anon('/api/unbekannt');
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'Nicht angemeldet' });
    const authed = await get('/api/unbekannt', { accept: 'text/html' });
    expect(authed.statusCode).toBe(404);
    expect(authed.json()).toEqual({ error: 'Nicht gefunden' });
    expect((await anon('/api')).statusCode).toBe(401);
  });

  it('no fallback for non-HTML requests, unsafe methods or missing assets', async () => {
    expect((await anon('/setup', 'application/json')).statusCode).toBe(404);
    expect((await anon('/assets/fehlt.js', '*/*')).statusCode).toBe(404);
    const post = await app.inject({ method: 'POST', url: '/setup', headers: { origin: ORIGIN, accept: 'text/html' } });
    expect(post.statusCode).toBe(404);
    expect(post.json()).toEqual({ error: 'Nicht gefunden' });
  });

  it('serves nothing when the directory has no index.html', async () => {
    await app.close();
    app = await makeApp({ webDir: join(base, 'fehlt') });
    expect((await anon('/')).statusCode).toBe(404);
    expect((await anon('/setup')).json()).toEqual({ error: 'Nicht gefunden' });
  });
});

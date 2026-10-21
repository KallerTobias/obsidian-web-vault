import { mkdtemp, mkdir, writeFile, readFile, stat, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { JsonStore } from '../../server/store/json-store';
import { loadSettings } from '../../server/store/settings';

let root: string;
let dataDir: string;
let vaultDir: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'vw-settings-'));
  dataDir = join(root, 'data');
  vaultDir = join(root, 'vault');
  await mkdir(dataDir);
  await mkdir(join(vaultDir, '.obsidian'), { recursive: true });
});
afterEach(() => rm(root, { recursive: true, force: true }));

const appJson = () => join(vaultDir, '.obsidian', 'app.json');

describe('loadSettings', () => {
  it('takes attachment folder and link format from .obsidian/app.json on first start', async () => {
    await writeFile(appJson(), JSON.stringify({ attachmentFolderPath: 'Anhänge', newLinkFormat: 'absolute' }));
    const s = (await loadSettings(dataDir, vaultDir)).get();
    expect(s.attachmentFolder).toBe('Anhänge');
    expect(s.newLinkFormat).toBe('absolute');
  });

  it('maps "/" to vault root and "./" to the note folder', async () => {
    await writeFile(appJson(), JSON.stringify({ attachmentFolderPath: '/' }));
    expect((await loadSettings(dataDir, vaultDir)).get().attachmentFolder).toBe('');
    await rm(join(dataDir, 'settings.json'));
    await writeFile(appJson(), JSON.stringify({ attachmentFolderPath: './' }));
    expect((await loadSettings(dataDir, vaultDir)).get().attachmentFolder).toBe('./');
  });

  it('falls back to defaults without app.json', async () => {
    await rm(appJson(), { force: true });
    const s = (await loadSettings(dataDir, vaultDir)).get();
    expect(s.attachmentFolder).toBe('');
    expect(s.newLinkFormat).toBe('shortest');
    expect(s.templatesFolder).toBe('');
    expect(s.dailyNotes.format).toBe('YYYY-MM-DD');
    expect(s.graph.mode).toBe('2d');
  });

  it('ignores invalid app.json and invalid values', async () => {
    await writeFile(appJson(), '{ not json');
    expect((await loadSettings(dataDir, vaultDir)).get().newLinkFormat).toBe('shortest');
    await rm(join(dataDir, 'settings.json'));
    await writeFile(appJson(), JSON.stringify({ attachmentFolderPath: 5, newLinkFormat: 'weird' }));
    const s = (await loadSettings(dataDir, vaultDir)).get();
    expect(s.attachmentFolder).toBe('');
    expect(s.newLinkFormat).toBe('shortest');
  });

  it('never overrides an existing settings.json with app.json', async () => {
    await writeFile(join(dataDir, 'settings.json'), JSON.stringify({ attachmentFolder: 'Mein', theme: 'dark' }));
    await writeFile(appJson(), JSON.stringify({ attachmentFolderPath: 'Anhänge', newLinkFormat: 'absolute' }));
    const s = (await loadSettings(dataDir, vaultDir)).get();
    expect(s.attachmentFolder).toBe('Mein');
    expect(s.newLinkFormat).toBe('shortest');
    expect(s.theme).toBe('dark');
  });

  it('persists the first-start settings and leaves app.json untouched', async () => {
    await writeFile(appJson(), JSON.stringify({ attachmentFolderPath: 'A' }));
    const before = await stat(appJson());
    const store = await loadSettings(dataDir, vaultDir);
    await store.update((s) => { s.theme = 'light'; });
    const after = await stat(appJson());
    expect(after.mtimeMs).toBe(before.mtimeMs);
    const saved = JSON.parse(await readFile(join(dataDir, 'settings.json'), 'utf8'));
    expect(saved.attachmentFolder).toBe('A');
    expect(saved.theme).toBe('light');
  });

  it('merges new default keys into stored settings', async () => {
    await writeFile(join(dataDir, 'settings.json'), JSON.stringify({ graph: { mode: '3d' }, dailyNotes: { folder: 'Tage' } }));
    const s = (await loadSettings(dataDir, vaultDir)).get();
    expect(s.graph.mode).toBe('3d');
    expect(s.graph.showOrphans).toBe(true);
    expect(s.dailyNotes.folder).toBe('Tage');
    expect(s.dailyNotes.format).toBe('YYYY-MM-DD');
  });
});

describe('JsonStore', () => {
  const file = () => join(dataDir, 'store.json');

  it('returns defaults for a missing file without creating it', async () => {
    const store = new JsonStore(file(), { n: 1 });
    expect(await store.load()).toEqual({ n: 1 });
    await expect(stat(file())).rejects.toThrow();
  });

  it('throws on corrupt JSON and does not touch the file', async () => {
    await writeFile(file(), '{ broken');
    const store = new JsonStore(file(), { n: 1 });
    await expect(store.load()).rejects.toThrow(/store\.json/);
    expect(await readFile(file(), 'utf8')).toBe('{ broken');
  });

  it('writes with mode 0600 and leaves no temp files', async () => {
    const store = new JsonStore(file(), { n: 1 });
    await store.update((t) => ({ n: t.n + 1 }));
    expect((await stat(file())).mode & 0o777).toBe(0o600);
    expect(await readdir(dataDir)).toEqual(['store.json']);
    expect(store.get()).toEqual({ n: 2 });
  });

  it('does not lose parallel updates', async () => {
    const store = new JsonStore(file(), { n: 0 });
    await Promise.all(Array.from({ length: 50 }, () => store.update((t) => { t.n += 1; })));
    expect(store.get().n).toBe(50);
    expect(JSON.parse(await readFile(file(), 'utf8')).n).toBe(50);
  });

  it('keeps going after a failing update and keeps state unchanged', async () => {
    const store = new JsonStore(file(), { n: 0 });
    await expect(store.update(() => { throw new Error('boom'); })).rejects.toThrow('boom');
    await store.update((t) => { t.n = 7; });
    expect(store.get().n).toBe(7);
  });

  it('get() and update() return deep copies, never the live state', async () => {
    const store = new JsonStore(file(), { nested: { n: 1 }, list: [1] });
    const updated = await store.update((t) => { t.nested.n = 2; });
    updated.nested.n = 99;
    updated.list.push(99);
    const got = store.get();
    got.nested.n = 42;
    got.list.push(42);
    expect(store.get()).toEqual({ nested: { n: 2 }, list: [1] });
  });

  it('load() returns a copy too', async () => {
    const store = new JsonStore(file(), { n: 1 });
    const loaded = await store.load();
    loaded.n = 5;
    expect(store.get().n).toBe(1);
  });

  it('throws when the stored top-level type differs from the defaults', async () => {
    for (const content of ['[]', '"text"', '5', 'null']) {
      await writeFile(file(), content);
      await expect(new JsonStore(file(), { n: 1 }).load()).rejects.toThrow(/store\.json/);
    }
    await writeFile(file(), '{}');
    await expect(new JsonStore(file(), [] as number[]).load()).rejects.toThrow(/store\.json/);
  });

  it('ignores __proto__, constructor and prototype keys while merging', async () => {
    await writeFile(
      file(),
      '{"__proto__":{"polluted":true},"constructor":{"x":1},"prototype":{"y":2},"nested":{"__proto__":{"evil":1},"n":3}}',
    );
    const store = new JsonStore(file(), { nested: { n: 1 } });
    const s = (await store.load()) as Record<string, unknown>;
    expect(Object.getPrototypeOf(s)).toBe(Object.prototype);
    expect(Object.hasOwn(s, 'constructor')).toBe(false);
    expect(Object.hasOwn(s, 'prototype')).toBe(false);
    expect((s as { polluted?: unknown }).polluted).toBeUndefined();
    const nested = s.nested as Record<string, unknown>;
    expect(nested.n).toBe(3);
    expect(Object.getPrototypeOf(nested)).toBe(Object.prototype);
    expect(({} as { polluted?: unknown; evil?: unknown }).polluted).toBeUndefined();
  });

  it('creates a missing data directory with mode 0700', async () => {
    const dir = join(root, 'fresh', 'data');
    const store = new JsonStore(join(dir, 'x.json'), { n: 1 });
    await store.update((t) => { t.n = 2; });
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
  });

  it('refresh() picks up writes from another instance (other process)', async () => {
    const a = new JsonStore(file(), { n: 0 });
    const b = new JsonStore(file(), { n: 0 });
    await a.update((t) => { t.n = 1; });
    await b.update((t) => { t.n += 10; });
    expect(b.get().n).toBe(11);
    await a.refresh();
    expect(a.get().n).toBe(11);
  });

  it('update() starts from the current file content, not a stale cache', async () => {
    const a = new JsonStore(file(), { list: [] as string[] });
    const b = new JsonStore(file(), { list: [] as string[] });
    await a.update((t) => { t.list.push('a'); });
    await b.update((t) => { t.list = []; });
    await a.update((t) => { t.list.push('a2'); });
    expect(JSON.parse(await readFile(file(), 'utf8')).list).toEqual(['a2']);
  });

  it('refresh() falls back to defaults when the file was removed', async () => {
    const a = new JsonStore(file(), { n: 0 });
    await a.update((t) => { t.n = 5; });
    await rm(file());
    await a.refresh();
    expect(a.get().n).toBe(0);
  });

  it('refresh() keeps the cache when the file is unchanged', async () => {
    const a = new JsonStore(file(), { n: 0 });
    await a.update((t) => { t.n = 5; });
    await a.refresh();
    expect(a.get().n).toBe(5);
  });

  it('does not mutate the defaults', async () => {
    const defaults = { list: [] as number[] };
    const store = new JsonStore(file(), defaults);
    await store.update((t) => { t.list.push(1); });
    expect(defaults.list).toEqual([]);
  });
});

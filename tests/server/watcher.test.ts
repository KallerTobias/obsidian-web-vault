import { chmod, mkdtemp, mkdir, rename, rm, writeFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EventBus, type VaultEvent } from '../../server/events';
import { SearchIndex } from '../../server/index/search';
import { VaultIndex } from '../../server/index/vault-index';
import { VaultFiles } from '../../server/vault/files';
import { VaultPaths } from '../../server/vault/paths';
import { VaultWatcher } from '../../server/vault/watcher';

let root: string;
let base: string;
let index: VaultIndex;
let search: SearchIndex;
let bus: EventBus;
let files: VaultFiles;
let watcher: VaultWatcher;
let events: VaultEvent[];

async function waitFor(cond: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('Timeout beim Warten auf Bedingung');
    await new Promise((r) => setTimeout(r, 25));
  }
}
const settle = () => new Promise((r) => setTimeout(r, 700));

let clock = 0;

async function startWatcher(exclude: string[] = []) {
  const paths = new VaultPaths(root, exclude, []);
  files = new VaultFiles(paths);
  watcher = new VaultWatcher({ root, paths, files, index, search, bus, now: () => Date.now() + clock });
  await watcher.start();
}

beforeEach(async () => {
  base = await realpath(await mkdtemp(path.join(tmpdir(), 'vw-watch-')));
  root = path.join(base, 'vault');
  await mkdir(root);
  index = new VaultIndex();
  search = new SearchIndex();
  bus = new EventBus();
  events = [];
  clock = 0;
  bus.subscribe((e) => events.push(e));
});

afterEach(async () => {
  await watcher?.stop();
  await rm(base, { recursive: true, force: true });
});

function recordingLog() {
  const lines: { level: string; obj: Record<string, unknown>; msg: string }[] = [];
  const at = (level: string) => (obj: object, msg: string) => void lines.push({ level, obj: obj as Record<string, unknown>, msg });
  return { lines, log: { info: at('info'), warn: at('warn'), error: at('error') } };
}

describe('VaultWatcher: Fehler sichtbar machen', () => {
  it('loggt EACCES einmal je Pfad (warn), ENOENT bleibt still', async () => {
    await writeFile(path.join(root, 'gesperrt.md'), 'x');
    await chmod(path.join(root, 'gesperrt.md'), 0o000);
    await writeFile(path.join(root, 'ok.md'), 'x');
    const { lines, log } = recordingLog();
    const paths = new VaultPaths(root, [], []);
    files = new VaultFiles(paths);
    watcher = new VaultWatcher({ root, paths, files, index, search, bus, log });
    await watcher.start();
    // zweiter Versuch über ein Änderungsereignis darf nicht erneut loggen
    await (watcher as unknown as { indexFile(p: string): Promise<unknown> }).indexFile('gesperrt.md');
    await (watcher as unknown as { indexFile(p: string): Promise<unknown> }).indexFile('gibtsnicht.md');
    const warns = lines.filter((l) => l.level === 'warn');
    expect(warns).toEqual([{ level: 'warn', obj: { path: 'gesperrt.md', code: 'EACCES' }, msg: 'Datei nicht lesbar, nicht im Index' }]);
    expect(lines.find((l) => l.msg === 'Vault indiziert')?.obj).toMatchObject({ files: 1 });
    await chmod(path.join(root, 'gesperrt.md'), 0o644);
  });

  it('indiziert Nicht-UTF-8-Notizen verlustbehaftet, ohne zu schreiben', async () => {
    const latin1 = Buffer.from([0x47, 0x72, 0xfc, 0xdf, 0x65, 0x20, 0x23, 0x74, 0x61, 0x67]);
    await writeFile(path.join(root, 'l.md'), latin1);
    await startWatcher();
    expect(index.note('l.md')?.tags.map((t) => t.tag)).toEqual(['tag']);
  });

  it('bricht ab, wenn der Watcher nicht rechtzeitig bereit ist', async () => {
    for (let i = 0; i < 50; i++) await mkdir(path.join(root, `d${i}`));
    const { lines, log } = recordingLog();
    const paths = new VaultPaths(root, [], []);
    files = new VaultFiles(paths);
    watcher = new VaultWatcher({ root, paths, files, index, search, bus, log, readyTimeoutMs: 0 });
    await expect(watcher.start()).rejects.toThrow(/nicht bereit/);
    expect(lines.some((l) => l.level === 'error' && l.msg === 'Vault-Watcher startet nicht')).toBe(true);
  });
});

describe('VaultWatcher', () => {
  it('indexes existing files on start without events', async () => {
    await mkdir(path.join(root, 'Ordner'));
    await writeFile(path.join(root, 'A.md'), 'Hallo [[B]] #tag');
    await writeFile(path.join(root, 'Ordner', 'B.md'), 'b');
    await writeFile(path.join(root, 'bild.png'), 'x');
    await startWatcher();
    expect(index.backlinks('Ordner/B.md').map((b) => b.source)).toEqual(['A.md']);
    expect(index.lookup().byPath.size).toBe(3);
    expect(search.search('Hallo').map((h) => h.path)).toEqual(['A.md']);
    expect(events).toEqual([]);
  });

  it('reports external changes with new version and updates the index', async () => {
    await writeFile(path.join(root, 'A.md'), 'a');
    await writeFile(path.join(root, 'B.md'), 'b');
    await startWatcher();
    await writeFile(path.join(root, 'A.md'), 'jetzt [[B]]');
    await waitFor(() => events.some((e) => e.type === 'changed'));
    const { version } = await files.read('A.md');
    expect(events).toMatchObject([{ type: 'changed', path: 'A.md', version }]);
    expect(index.backlinks('B.md').map((b) => b.source)).toEqual(['A.md']);
  });

  it('reports created files (NFC path for NFD names) and deletions', async () => {
    await startWatcher();
    const nfd = 'Übersicht.md';
    await writeFile(path.join(root, nfd), 'x');
    await waitFor(() => events.some((e) => e.type === 'created'));
    expect(events[0]).toMatchObject({ type: 'created', path: 'Übersicht.md' });
    expect(index.note('Übersicht.md')).toBeDefined();
    await rm(path.join(root, nfd));
    await waitFor(() => events.some((e) => e.type === 'deleted'));
    expect(events[1]).toMatchObject({ type: 'deleted', path: 'Übersicht.md' });
    expect(index.note('Übersicht.md')).toBeUndefined();
    expect(search.search('x').length).toBe(0);
  });

  it('indexes attachments as files', async () => {
    await startWatcher();
    await writeFile(path.join(root, 'bild.png'), 'x');
    await waitFor(() => events.length === 1);
    expect(events[0]).toMatchObject({ type: 'created', path: 'bild.png' });
    await writeFile(path.join(root, 'A.md'), '![[bild.png]]');
    await waitFor(() => events.length === 2);
    expect(index.note('A.md')?.resolved).toEqual(['bild.png']);
  });

  it('ignores dotfiles, .tmp and excluded paths', async () => {
    await mkdir(path.join(root, 'Privat'));
    await mkdir(path.join(root, '.obsidian'));
    await startWatcher(['Privat/**']);
    await writeFile(path.join(root, '.obsidian', 'x.md'), 'x');
    await writeFile(path.join(root, '.versteckt.md'), 'x');
    await writeFile(path.join(root, 'A.md.abc123.tmp'), 'x');
    await writeFile(path.join(root, 'Privat', 'g.md'), 'x');
    await writeFile(path.join(root, 'Sichtbar.md'), 'x');
    await waitFor(() => events.length >= 1);
    await settle();
    expect(events.map((e) => (e as { path: string }).path)).toEqual(['Sichtbar.md']);
    expect(index.lookup().byPath.size).toBe(1);
  });

  it('does not report own writes twice but updates the index', async () => {
    await writeFile(path.join(root, 'B.md'), 'b');
    await startWatcher();
    const content = 'eigen [[B]]';
    await files.create('A.md', content);
    const { version } = await files.read('A.md');
    watcher.markOwnWrite('A.md', version);
    await waitFor(() => index.backlinks('B.md').length === 1);
    await settle();
    expect(events).toEqual([]);
    // a later external change is still reported
    await writeFile(path.join(root, 'A.md'), 'extern');
    await waitFor(() => events.length === 1);
    expect(events[0]).toMatchObject({ type: 'changed', path: 'A.md' });
  });

  it('removes files of a deleted folder', async () => {
    await mkdir(path.join(root, 'D'));
    await writeFile(path.join(root, 'D', 'A.md'), 'a');
    await startWatcher();
    await rm(path.join(root, 'D'), { recursive: true });
    await waitFor(() => events.length === 1);
    expect(events[0]).toMatchObject({ type: 'deleted', path: 'D/A.md' });
    expect(index.note('D/A.md')).toBeUndefined();
  });

  it('a move becomes deleted + created', async () => {
    await writeFile(path.join(root, 'A.md'), 'a');
    await startWatcher();
    await rename(path.join(root, 'A.md'), path.join(root, 'N.md'));
    await waitFor(() => events.length === 2);
    expect(events.map((e) => e.type).sort()).toEqual(['created', 'deleted']);
    expect(index.note('N.md')).toBeDefined();
    expect(index.note('A.md')).toBeUndefined();
  });

  it('own moves are silent but update the index', async () => {
    await writeFile(path.join(root, 'A.md'), 'a');
    await startWatcher();
    watcher.markOwnMove('A.md', 'N.md');
    await rename(path.join(root, 'A.md'), path.join(root, 'N.md'));
    await waitFor(() => index.note('N.md') !== undefined && index.note('A.md') === undefined);
    await settle();
    expect(events).toEqual([]);
    // later external changes of the moved file are reported again
    await writeFile(path.join(root, 'N.md'), 'extern');
    await waitFor(() => events.length === 1);
    expect(events[0]).toMatchObject({ type: 'changed', path: 'N.md' });
  });

  it('own folder moves are silent for all contained paths', async () => {
    await mkdir(path.join(root, 'D', 'Sub'), { recursive: true });
    await writeFile(path.join(root, 'D', 'A.md'), 'a');
    await writeFile(path.join(root, 'D', 'Sub', 'B.md'), 'b');
    await writeFile(path.join(root, 'Dx.md'), 'nicht betroffen');
    await startWatcher();
    watcher.markOwnMove('D', 'E/F');
    await mkdir(path.join(root, 'E'));
    await rename(path.join(root, 'D'), path.join(root, 'E', 'F'));
    await waitFor(() => index.note('E/F/Sub/B.md') !== undefined && index.note('D/A.md') === undefined);
    await rm(path.join(root, 'Dx.md'));
    await waitFor(() => events.length === 1);
    await settle();
    expect(events).toMatchObject([{ type: 'deleted', path: 'Dx.md' }]);
    expect(index.note('E/F/A.md')).toBeDefined();
    expect(index.note('D/Sub/B.md')).toBeUndefined();
  });

  it('an undone move mark no longer suppresses events', async () => {
    await writeFile(path.join(root, 'A.md'), 'a');
    await startWatcher();
    watcher.markOwnMove('A.md', 'N.md');
    watcher.unmarkOwnMove('A.md', 'N.md');
    await rename(path.join(root, 'A.md'), path.join(root, 'N.md'));
    await waitFor(() => events.length === 2);
    expect(events.map((e) => e.type).sort()).toEqual(['created', 'deleted']);
  });

  it('marks expire after 10 s', async () => {
    await writeFile(path.join(root, 'A.md'), 'a');
    await startWatcher();
    const { version } = await files.read('A.md');
    watcher.markOwnMove('A.md', 'N.md');
    clock = 10_001;
    await rename(path.join(root, 'A.md'), path.join(root, 'N.md'));
    await waitFor(() => events.length === 2);
    expect(events.map((e) => e.type).sort()).toEqual(['created', 'deleted']);
    clock = 0;
    watcher.markOwnWrite('A.md', version);
    clock = 10_001;
    await writeFile(path.join(root, 'A.md'), 'a');
    await waitFor(() => events.length === 3);
    expect(events[2]).toMatchObject({ type: 'created', path: 'A.md' });
  });
});

describe('EventBus', () => {
  it('assigns increasing seq and returns events since', () => {
    const b = new EventBus();
    const e1 = b.publish({ type: 'created', path: 'a.md' });
    b.publish({ type: 'deleted', path: 'a.md' });
    expect(e1.seq).toBe(1);
    expect(b.seq).toBe(2);
    expect((b.since(1) as VaultEvent[]).map((e) => e.seq)).toEqual([2]);
    expect(b.since(2)).toEqual([]);
  });
  it('returns gap when the ring buffer no longer covers seq', () => {
    const b = new EventBus();
    for (let i = 0; i < 1500; i++) b.publish({ type: 'changed', path: 'a.md' });
    expect(b.since(100)).toBe('gap');
    expect(b.since(499)).toBe('gap');
    expect(b.since(500)).toHaveLength(1000);
    expect(b.since(501)).toHaveLength(999);
    expect(b.since(1500)).toEqual([]);
  });
  it('unsubscribes', () => {
    const b = new EventBus();
    const got: number[] = [];
    const off = b.subscribe((e) => got.push(e.seq));
    b.publish({ type: 'created', path: 'a' });
    off();
    b.publish({ type: 'created', path: 'b' });
    expect(got).toEqual([1]);
  });
});

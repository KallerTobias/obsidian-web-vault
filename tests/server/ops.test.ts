import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EventBus, type VaultEvent } from '../../server/events';
import { VaultIndex } from '../../server/index/vault-index';
import { ConflictError, VaultFiles, type TreeEntry, type Version } from '../../server/vault/files';
import { TargetExistsError, VaultOps } from '../../server/vault/ops';
import { PathError, VaultPaths } from '../../server/vault/paths';

let base: string;
let root: string;
let paths: VaultPaths;
let files: VaultFiles;
let index: VaultIndex;
let bus: EventBus;
let events: VaultEvent[];
let marks: { writes: [string, Version][]; moves: [string, string][]; unmoves: [string, string][] };
let ops: VaultOps;

const sha = (s: string) => createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex');

async function put(rel: string, content: string): Promise<void> {
  await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
  await writeFile(path.join(root, rel), content);
}
const get = (rel: string) => readFile(path.join(root, rel), 'utf8');
const exists = (rel: string) => readFile(path.join(root, rel)).then(() => true, () => false);

async function buildIndex(): Promise<void> {
  const walk = async (e: TreeEntry): Promise<void> => {
    for (const c of e.children ?? []) {
      if (c.kind === 'folder') await walk(c);
      else if (c.kind === 'note') index.upsert(c.path, (await files.read(c.path)).content);
      else index.addFile(c.path);
    }
  };
  await walk(await files.tree());
}

function usePaths(exclude: string[], readonly: string[]): void {
  paths = new VaultPaths(root, exclude, readonly);
  files = new VaultFiles(paths);
  ops = makeOps();
}

function makeOps(f: VaultFiles = files): VaultOps {
  return new VaultOps({
    paths,
    files: f,
    index,
    bus,
    watcher: {
      markOwnWrite: (p, v) => marks.writes.push([p, v]),
      markOwnMove: (from, to) => marks.moves.push([from, to]),
      unmarkOwnMove: (from, to) => marks.unmoves.push([from, to]),
    },
  });
}

async function setup(vault: Record<string, string>): Promise<void> {
  for (const [rel, content] of Object.entries(vault)) await put(rel, content);
  await buildIndex();
}

async function errOf(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  return undefined;
}

beforeEach(async () => {
  base = await realpath(await mkdtemp(path.join(tmpdir(), 'vw-ops-')));
  root = path.join(base, 'vault');
  await mkdir(root);
  paths = new VaultPaths(root, ['Privat/**'], ['Homelab/**']);
  files = new VaultFiles(paths);
  index = new VaultIndex();
  bus = new EventBus();
  events = [];
  bus.subscribe((e) => events.push(e));
  marks = { writes: [], moves: [], unmoves: [] };
  ops = makeOps();
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

describe('VaultOps.rename', () => {
  it('renames a note and updates every linking note', async () => {
    await setup({
      'NXTZLT/Geteilt/A.md': '# A\n[[#A]]',
      'Quelle.md': 'x [[A]] und [[NXTZLT/Geteilt/A|X]]\r\n',
      'Md.md': '[t](NXTZLT/Geteilt/A.md#A)',
      'Other.md': 'nichts',
    });
    const r = await ops.rename('NXTZLT/Geteilt/A.md', 'NXTZLT/Archiv/A neu.md', true);

    expect(r).toEqual({
      moved: [{ from: 'NXTZLT/Geteilt/A.md', to: 'NXTZLT/Archiv/A neu.md' }],
      updated: ['Md.md', 'Quelle.md'],
      skippedReadonly: [],
      conflicts: [],
      failed: [],
    });
    expect(await exists('NXTZLT/Geteilt/A.md')).toBe(false);
    expect(await get('NXTZLT/Archiv/A neu.md')).toBe('# A\n[[#A]]');
    expect(await get('Quelle.md')).toBe('x [[A neu]] und [[NXTZLT/Archiv/A neu|X]]\r\n');
    expect(await get('Md.md')).toBe('[t](NXTZLT/Archiv/A%20neu.md#A)');
    expect(await get('Other.md')).toBe('nichts');

    expect(events.map((e) => e.type)).toEqual(['renamed', 'changed', 'changed']);
    expect(events[0]).toMatchObject({ type: 'renamed', from: 'NXTZLT/Geteilt/A.md', to: 'NXTZLT/Archiv/A neu.md' });
    expect(events.slice(1)).toMatchObject([
      { path: 'Md.md', version: sha(await get('Md.md')) },
      { path: 'Quelle.md', version: sha(await get('Quelle.md')) },
    ]);
    expect(marks.moves).toEqual([['NXTZLT/Geteilt/A.md', 'NXTZLT/Archiv/A neu.md']]);
    expect(marks.writes).toEqual([
      ['Md.md', sha(await get('Md.md'))],
      ['Quelle.md', sha(await get('Quelle.md'))],
    ]);
    // index is consistent right away
    expect(index.note('NXTZLT/Geteilt/A.md')).toBeUndefined();
    expect(index.backlinks('NXTZLT/Archiv/A neu.md').map((b) => b.source)).toEqual(['Md.md', 'Quelle.md']);
  });

  it('without updateLinks only moves', async () => {
    await setup({ 'A.md': 'a', 'Quelle.md': '[[A]]' });
    const r = await ops.rename('A.md', 'B.md', false);
    expect(r).toEqual({ moved: [{ from: 'A.md', to: 'B.md' }], updated: [], skippedReadonly: [], conflicts: [], failed: [] });
    expect(await get('Quelle.md')).toBe('[[A]]');
    expect(events.map((e) => e.type)).toEqual(['renamed']);
    expect(index.note('B.md')).toBeDefined();
  });

  it('moves a folder with all contained paths and links', async () => {
    await setup({
      'Projekt/A.md': '[[B]] [s](Sub/B.md)',
      'Projekt/Sub/B.md': '[a](../A.md)',
      'Projekt/bild.png': 'png',
      'Index.md': '[[Projekt/A]] [[Projekt/Sub/B|b]] [x](Projekt/Sub/B.md) ![[Projekt/bild.png]]',
      'Projektplan.md': 'nicht betroffen',
    });
    const r = await ops.rename('Projekt', 'Archiv/Projekt 2026', true);

    expect(r.moved).toEqual([
      { from: 'Projekt/A.md', to: 'Archiv/Projekt 2026/A.md' },
      { from: 'Projekt/Sub/B.md', to: 'Archiv/Projekt 2026/Sub/B.md' },
      { from: 'Projekt/bild.png', to: 'Archiv/Projekt 2026/bild.png' },
    ]);
    expect(r.updated).toEqual(['Index.md']);
    expect(await get('Index.md')).toBe(
      '[[Archiv/Projekt 2026/A]] [[Archiv/Projekt 2026/Sub/B|b]] [x](Archiv/Projekt%202026/Sub/B.md) ![[Archiv/Projekt 2026/bild.png]]',
    );
    // links inside the moved folder still resolve and stay as they were
    expect(await get('Archiv/Projekt 2026/A.md')).toBe('[[B]] [s](Sub/B.md)');
    expect(await get('Archiv/Projekt 2026/Sub/B.md')).toBe('[a](../A.md)');
    expect(await readdir(root)).not.toContain('Projekt');
    expect(events.map((e) => e.type)).toEqual(['renamed', 'changed']);
    expect(events[0]).toMatchObject({ from: 'Projekt', to: 'Archiv/Projekt 2026' });
    expect(marks.moves).toEqual([['Projekt', 'Archiv/Projekt 2026']]);
    expect(index.backlinks('Archiv/Projekt 2026/Sub/B.md').map((b) => b.source)).toEqual(['Archiv/Projekt 2026/A.md', 'Index.md']);
    expect(index.note('Projekt/A.md')).toBeUndefined();
  });

  it('refuses an existing target and changes nothing', async () => {
    await setup({ 'A.md': 'a', 'B.md': 'b', 'Quelle.md': '[[A]]' });
    const e = await errOf(ops.rename('A.md', 'B.md', true));
    expect(e).toBeInstanceOf(TargetExistsError);
    expect(e).toBeInstanceOf(ConflictError);
    expect(await get('A.md')).toBe('a');
    expect(await get('B.md')).toBe('b');
    expect(await get('Quelle.md')).toBe('[[A]]');
    expect(events).toEqual([]);
    expect(marks).toEqual({ writes: [], moves: [], unmoves: [] });
  });

  it('refuses hidden, excluded and readonly paths and moving a folder into itself', async () => {
    await setup({ 'A.md': 'a', 'Homelab/H.md': 'h', 'D/x.md': 'x' });
    const code = async (p: Promise<unknown>) => ((await errOf(p)) as PathError).code;
    expect(await code(ops.rename('A.md', '.obsidian/A.md', true))).toBe('HIDDEN');
    expect(await code(ops.rename('A.md', 'Privat/A.md', true))).toBe('EXCLUDED');
    expect(await code(ops.rename('A.md', 'Homelab/A.md', true))).toBe('READONLY');
    expect(await code(ops.rename('Homelab/H.md', 'H.md', true))).toBe('READONLY');
    expect(await code(ops.rename('Homelab', 'Lab', true))).toBe('READONLY');
    expect(await errOf(ops.rename('D', 'D/E', true))).toBeInstanceOf(Error);
    expect(await get('A.md')).toBe('a');
    expect(await get('D/x.md')).toBe('x');
    expect(events).toEqual([]);
  });

  it('refuses folders with excluded or readonly content on disk; dotfiles travel along', async () => {
    usePaths(['Privat/**', '*/Intern/**'], ['Homelab/**', 'Ziel/Sub/**']);
    await setup({ 'P/a.md': 'a', 'P/Intern/geheim.md': 'g', 'Q/Sub/x.md': 'x', 'Q/.DS_Store': 'ds' });
    const code = async (p: Promise<unknown>) => ((await errOf(p)) as PathError).code;
    expect(await code(ops.rename('P', 'P2', true))).toBe('EXCLUDED');
    expect(await code(ops.trash('P'))).toBe('EXCLUDED');
    expect(await get('P/Intern/geheim.md')).toBe('g');
    expect(await get('P/a.md')).toBe('a');
    // content would land on a readonly / excluded glob
    expect(await code(ops.rename('Q', 'Ziel', true))).toBe('READONLY');
    expect(await code(ops.rename('Q', 'R/Intern', true))).toBe('EXCLUDED');
    expect(await get('Q/Sub/x.md')).toBe('x');
    expect(events).toEqual([]);
    expect(marks.moves).toEqual([]);
    // a hidden file inside a movable folder moves with it
    await ops.rename('Q', 'R', true);
    expect(await get('R/.DS_Store')).toBe('ds');
    expect(await get('R/Sub/x.md')).toBe('x');
  });

  it('undoes the move mark when the move fails', async () => {
    await setup({ 'A.md': 'a' });
    ops = new VaultOps({
      paths,
      files,
      index,
      bus,
      watcher: {
        markOwnWrite: () => undefined,
        markOwnMove: (from, to) => {
          marks.moves.push([from, to]);
          writeFileSync(path.join(root, 'B.md'), 'schneller'); // a concurrent writer takes the target
        },
        unmarkOwnMove: (from, to) => marks.unmoves.push([from, to]),
      },
    });
    expect(await errOf(ops.rename('A.md', 'B.md', true))).toBeInstanceOf(TargetExistsError);
    expect(marks.unmoves).toEqual([['A.md', 'B.md']]);
    expect(await get('A.md')).toBe('a');
    expect(await get('B.md')).toBe('schneller');
    expect(events).toEqual([]);
  });

  it('collects notes that cannot be written and still returns the result', async () => {
    await setup({ 'A.md': 'a', 'Quelle.md': '[[A]]', 'Zweite.md': '[[A]]' });
    class FailingFiles extends VaultFiles {
      override async write(rel: string, content: string, baseVersion: Version): Promise<Version> {
        if (rel === 'Quelle.md') throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
        return super.write(rel, content, baseVersion);
      }
    }
    ops = makeOps(new FailingFiles(paths));
    const r = await ops.rename('A.md', 'B.md', true);
    expect(r.failed).toEqual(['Quelle.md']);
    expect(r.conflicts).toEqual([]);
    expect(r.updated).toEqual(['Zweite.md']);
    expect(await get('Quelle.md')).toBe('[[A]]');
  });

  it('never rewrites a non-UTF-8 linking note: reports it as failed, bytes unchanged', async () => {
    await setup({ 'A.md': 'a', 'Zweite.md': '[[A]]' });
    const latin1 = Buffer.concat([Buffer.from('[[A]] '), Buffer.from([0xfc])]);
    await writeFile(path.join(root, 'Latin.md'), latin1);
    index.upsert('Latin.md', (await files.read('Latin.md', { lossy: true })).content);
    const r = await ops.rename('A.md', 'B.md', true);
    expect(r.failed).toEqual(['Latin.md']);
    expect(r.updated).toEqual(['Zweite.md']);
    expect((await readFile(path.join(root, 'Latin.md'))).equals(latin1)).toBe(true);
  });

  it('reports linking notes in readonly areas instead of rewriting them', async () => {
    await setup({ 'A.md': 'a', 'Homelab/Notiz.md': '[[A]]', 'Quelle.md': '[[A]]' });
    const r = await ops.rename('A.md', 'B.md', true);
    expect(r.skippedReadonly).toEqual(['Homelab/Notiz.md']);
    expect(r.updated).toEqual(['Quelle.md']);
    expect(await get('Homelab/Notiz.md')).toBe('[[A]]');
  });

  it('never overwrites a note changed between reading and writing', async () => {
    await setup({ 'A.md': 'a', 'Quelle.md': '[[A]]', 'Zweite.md': '[[A]]' });
    class RacyFiles extends VaultFiles {
      override async write(rel: string, content: string, baseVersion: Version): Promise<Version> {
        if (rel === 'Quelle.md') await writeFile(path.join(root, 'Quelle.md'), 'extern [[A]]');
        return super.write(rel, content, baseVersion);
      }
    }
    ops = makeOps(new RacyFiles(paths));
    const r = await ops.rename('A.md', 'B.md', true);
    expect(r.conflicts).toEqual(['Quelle.md']);
    expect(r.updated).toEqual(['Zweite.md']);
    expect(await get('Quelle.md')).toBe('extern [[A]]');
    expect(await get('Zweite.md')).toBe('[[B]]');
    expect(events.map((e) => (e.type === 'changed' ? e.path : e.type))).toEqual(['renamed', 'Zweite.md']);
  });

  it('handles –, (, #, %, spaces and NFD names', async () => {
    const nfd = 'Übersicht'.normalize('NFD');
    await setup({
      'Notizen/Plan (alt).md': 'p',
      'Wiki – 50% (x).md': 'w',
      [`${nfd}.md`]: 'ü',
      'Quelle.md': '[p](Notizen/Plan%20%28alt%29.md) [[Wiki – 50% (x)|W]] [[Übersicht]] [u](%C3%9Cbersicht.md)',
    });
    await ops.rename('Notizen/Plan (alt).md', 'Notizen/C# – 100% Plan (neu).md', true);
    await ops.rename('Wiki – 50% (x).md', 'Wiki – 75% (y).md', true);
    const r = await ops.rename('Übersicht.md', 'Übersicht neu.md', true);
    expect(r.moved).toEqual([{ from: 'Übersicht.md', to: 'Übersicht neu.md' }]);
    expect(await get('Quelle.md')).toBe(
      '[p](Notizen/C%23%20%E2%80%93%20100%25%20Plan%20%28neu%29.md) [[Wiki – 75% (y)|W]] [[Übersicht neu]] [u](%C3%9Cbersicht%20neu.md)',
    );
    expect(await get('Notizen/C# – 100% Plan (neu).md')).toBe('p');
    expect(await get('Übersicht neu.md')).toBe('ü');
    expect((await readdir(root)).map((n) => n.normalize('NFC'))).not.toContain('Übersicht.md');
    expect(index.backlinks('Notizen/C# – 100% Plan (neu).md').map((b) => b.source)).toEqual(['Quelle.md']);
  });
});

describe('VaultOps.trash', () => {
  it('moves files and folders into .trash with unique names', async () => {
    await setup({ 'a/b.md': '1', 'c/b.md': '2', 'x/a/n.md': '3', 'Quelle.md': '[[b]]' });
    await ops.trash('a/b.md');
    await ops.trash('c/b.md');
    expect(await get('.trash/b.md')).toBe('1');
    expect(await get('.trash/b 1.md')).toBe('2');
    expect(await exists('a/b.md')).toBe(false);
    await ops.trash('a');
    await ops.trash('x/a');
    expect(await readdir(path.join(root, '.trash'))).toEqual(expect.arrayContaining(['a', 'a 1']));
    expect(await get('.trash/a 1/n.md')).toBe('3');
    expect(events).toMatchObject([
      { type: 'deleted', path: 'a/b.md' },
      { type: 'deleted', path: 'c/b.md' },
      { type: 'deleted', path: 'a' },
      { type: 'deleted', path: 'x/a' },
    ]);
    expect(marks.moves).toEqual([
      ['a/b.md', '.trash/b.md'],
      ['c/b.md', '.trash/b 1.md'],
      ['a', '.trash/a'],
      ['x/a', '.trash/a 1'],
    ]);
    expect(index.note('x/a/n.md')).toBeUndefined();
    expect(index.note('Quelle.md')?.resolved).toEqual([null]);
  });

  it('refuses hidden, excluded and readonly paths', async () => {
    await setup({ 'Homelab/H.md': 'h', 'Privat/P.md': 'p' });
    await put('.obsidian/app.json', '{}');
    const code = async (p: Promise<unknown>) => ((await errOf(p)) as PathError).code;
    expect(await code(ops.trash('.obsidian/app.json'))).toBe('HIDDEN');
    expect(await code(ops.trash('.trash'))).toBe('HIDDEN');
    expect(await code(ops.trash('Privat/P.md'))).toBe('EXCLUDED');
    expect(await code(ops.trash('Homelab/H.md'))).toBe('READONLY');
    expect(await code(ops.trash('Homelab'))).toBe('READONLY');
    expect(await get('Homelab/H.md')).toBe('h');
    expect(events).toEqual([]);
  });
});

describe('VaultOps.affectedBy', () => {
  it('lists notes linking to a file or into a folder', async () => {
    await setup({ 'D/A.md': 'a', 'D/B.md': '[[A]]', 'X.md': '[[A]]', 'Y.md': '[[B]]', 'Z.md': 'nichts' });
    expect(ops.affectedBy('D/A.md')).toEqual(['D/B.md', 'X.md']);
    expect(ops.affectedBy('D')).toEqual(['D/B.md', 'X.md', 'Y.md']);
    expect(ops.affectedBy('Fehlt.md')).toEqual([]);
  });
});

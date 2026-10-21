import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readdir, readFile, rm, stat, symlink, utimes, writeFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConflictError, NotAFileError, NotUtf8Error, VaultFiles, isOwnTempName, type TreeEntry } from '../../server/vault/files';
import { PathError, VaultPaths } from '../../server/vault/paths';

let base: string;
let root: string;
let vf: VaultFiles;
let oldUmask: number;

const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

beforeEach(async () => {
  oldUmask = process.umask(0o002);
  base = await realpath(await mkdtemp(path.join(tmpdir(), 'vw-files-')));
  root = path.join(base, 'vault');
  await mkdir(root);
  vf = new VaultFiles(new VaultPaths(root, ['Privat/**'], ['Homelab/**']));
});
afterEach(async () => {
  process.umask(oldUmask);
  await rm(base, { recursive: true, force: true });
});

async function errOf(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  return undefined;
}
async function codeOf(p: Promise<unknown>): Promise<string | undefined> {
  const e = await errOf(p);
  return e instanceof PathError ? e.code : e === undefined ? undefined : `other:${String(e)}`;
}

describe('tree', () => {
  it('blendet Dotfiles und Excludes aus, Ordner zuerst, alphabetisch (de, numerisch)', async () => {
    await mkdir(path.join(root, '.git'));
    await mkdir(path.join(root, '.obsidian'));
    await mkdir(path.join(root, 'Privat'));
    await mkdir(path.join(root, 'Zeta'));
    await mkdir(path.join(root, 'Äpfel'));
    await mkdir(path.join(root, 'Homelab', '.versteckt'), { recursive: true });
    await writeFile(path.join(root, 'Homelab', '.versteckt', 'a.md'), 'x');
    await writeFile(path.join(root, 'Homelab', 'n.md'), 'x');
    await writeFile(path.join(root, '.hidden.md'), 'x');
    await writeFile(path.join(root, 'b.md'), 'bb');
    await writeFile(path.join(root, 'a10.md'), 'x');
    await writeFile(path.join(root, 'a2.md'), 'x');
    await writeFile(path.join(root, 'bild.png'), 'x');
    const t = await vf.tree();
    expect(t.kind).toBe('folder');
    expect(t.path).toBe('');
    expect(t.children!.map((c) => c.name)).toEqual(['Äpfel', 'Homelab', 'Zeta', 'a2.md', 'a10.md', 'b.md', 'bild.png']);
    const kinds = Object.fromEntries(t.children!.map((c) => [c.name, c.kind]));
    expect(kinds['b.md']).toBe('note');
    expect(kinds['bild.png']).toBe('file');
    const b = t.children!.find((c) => c.name === 'b.md') as TreeEntry;
    expect(b.size).toBe(2);
    expect(b.mtime).toBeGreaterThan(0);
    const hl = t.children!.find((c) => c.name === 'Homelab')!;
    expect(hl.children!.map((c) => c.path)).toEqual(['Homelab/n.md']);
    expect(hl.children![0]!.readonly).toBe(true);
    expect(b.readonly).toBe(false);
  });

  it('liefert NFC-Pfade auch bei NFD-Namen auf der Platte', async () => {
    await mkdir(path.join(root, 'Übersicht'));
    await writeFile(path.join(root, 'Übersicht', 'n.md'), 'x');
    const t = await vf.tree();
    expect(t.children![0]!.path).toBe('Übersicht');
    expect(t.children![0]!.children![0]!.path).toBe('Übersicht/n.md');
  });

  it('folgt keinen Symlinks aus dem Vault', async () => {
    const outside = path.join(base, 'outside');
    await mkdir(outside);
    await symlink(outside, path.join(root, 'link'));
    await symlink(path.join(base, 'nowhere'), path.join(root, 'dangling'));
    await writeFile(path.join(root, 'ok.md'), 'x');
    const t = await vf.tree();
    expect(t.children!.map((c) => c.name)).toEqual(['ok.md']);
  });
});

describe('tree: gleiche Sichtbarkeit wie der Watcher', () => {
  it('blendet *.tmp (Syncthing) und eigene .vwtmp-Dateien aus', async () => {
    await writeFile(path.join(root, 'A.md.abc123.tmp'), 'x');
    await writeFile(path.join(root, '~syncthing~B.md.tmp'), 'x');
    await writeFile(path.join(root, '.A.md.0123456789ab.vwtmp'), 'x');
    await mkdir(path.join(root, 'ordner.tmp'));
    await writeFile(path.join(root, 'ordner.tmp', 'n.md'), 'x');
    await writeFile(path.join(root, 'A.md'), 'x');
    const t = await vf.tree();
    expect(t.children!.map((c) => c.name)).toEqual(['A.md']);
  });
});

describe('Temp-Dateien', () => {
  it('isOwnTempName erkennt nur das eigene Muster', () => {
    expect(isOwnTempName('.Notiz.md.0123456789ab.vwtmp')).toBe(true);
    expect(isOwnTempName('.Notiz mit\nUmbruch.md.0123456789ab.vwtmp')).toBe(true);
    expect(isOwnTempName('Notiz.md.0123456789ab.vwtmp')).toBe(false);
    expect(isOwnTempName('.Notiz.md.0123456789ab.tmp')).toBe(false);
    expect(isOwnTempName('.Notiz.md.xyz.vwtmp')).toBe(false);
    expect(isOwnTempName('.syncthing.Notiz.md.tmp')).toBe(false);
  });
  it('kürzt sehr lange Namen im Temp-Namen (NAME_MAX)', async () => {
    const name = `${'ä'.repeat(120)}.md`; // 242 Bytes
    await writeFile(path.join(root, name), 'alt');
    await vf.write(name, 'neu', sha('alt'));
    expect(await readFile(path.join(root, name), 'utf8')).toBe('neu');
  });
  it('removeOrphanTemps entfernt nur eigene, über eine Stunde alte Temp-Dateien in sichtbaren Ordnern', async () => {
    const old = new Date(Date.now() - 2 * 3600_000);
    const mk = async (rel: string, age: Date | undefined) => {
      await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
      await writeFile(path.join(root, rel), 'x');
      if (age) await utimes(path.join(root, rel), age, age);
    };
    await mk('.A.md.0123456789ab.vwtmp', old);
    await mk('Ordner/.B.md.0123456789ab.vwtmp', old);
    await mk('.C.md.0123456789ab.vwtmp', undefined); // jung: evtl. laufender Schreibvorgang
    await mk('D.md.0123456789ab.tmp', old); // fremdes / altes Muster
    await mk('.E.md.tmp', old);
    await mk('.git/.F.md.0123456789ab.vwtmp', old); // versteckter Ordner: nie anfassen
    await mk('Privat/.G.md.0123456789ab.vwtmp', old); // ausgeschlossen
    const removed = await vf.removeOrphanTemps(3600_000);
    expect(removed.sort()).toEqual(['.A.md.0123456789ab.vwtmp', 'Ordner/.B.md.0123456789ab.vwtmp']);
    expect((await readdir(root)).sort()).toEqual(['.C.md.0123456789ab.vwtmp', '.E.md.tmp', '.git', 'D.md.0123456789ab.tmp', 'Ordner', 'Privat']);
    expect(await readdir(path.join(root, '.git'))).toEqual(['.F.md.0123456789ab.vwtmp']);
    expect(await readdir(path.join(root, 'Privat'))).toEqual(['.G.md.0123456789ab.vwtmp']);
  });
});

describe('stageUpload / createFromStaged', () => {
  it('streamt in eine versteckte Temp-Datei, legt das Ziel exklusiv an und räumt auf', async () => {
    const staged = await vf.stageUpload(Readable.from([Buffer.from('ab'), Buffer.from('c')]));
    expect(staged.size).toBe(3);
    expect(staged.version).toBe(sha('abc'));
    const names = await readdir(root);
    expect(names).toHaveLength(1);
    expect(names[0]).toMatch(/^\.upload\.[0-9a-f]{12}\.vwtmp$/);
    expect(isOwnTempName(names[0]!)).toBe(true);
    await vf.createFromStaged('A/b.bin', staged);
    expect(await readFile(path.join(root, 'A/b.bin'), 'utf8')).toBe('abc');
    expect(await errOf(vf.createFromStaged('A/b.bin', staged))).toBeInstanceOf(ConflictError);
    expect(await codeOf(vf.createFromStaged('.git/x', staged))).toBe('HIDDEN');
    await staged.discard();
    expect((await readdir(root)).sort()).toEqual(['A']);
  });
  it('räumt die Temp-Datei bei einem Stream-Fehler weg', async () => {
    const failing = new Readable({
      read() {
        this.destroy(new Error('abgebrochen'));
      },
    });
    await expect(vf.stageUpload(failing)).rejects.toThrow('abgebrochen');
    expect(await readdir(root)).toEqual([]);
  });
});

describe('Nicht-UTF-8', () => {
  const latin1 = Buffer.from([0x47, 0x72, 0xfc, 0xdf, 0x65]); // "Grüße" in Latin-1
  it('read verweigert ungültiges UTF-8 (NotUtf8Error), lossy liefert Ersatzzeichen', async () => {
    await writeFile(path.join(root, 'l.md'), latin1);
    expect(await errOf(vf.read('l.md'))).toBeInstanceOf(NotUtf8Error);
    const r = await vf.read('l.md', { lossy: true });
    expect(r.content).toContain('\ufffd');
    expect(r.version).toBe(sha(latin1));
  });
  it('write überschreibt eine Nicht-UTF-8-Datei nie, auch mit passender Version', async () => {
    await writeFile(path.join(root, 'l.md'), latin1);
    expect(await errOf(vf.write('l.md', 'neu', sha(latin1)))).toBeInstanceOf(NotUtf8Error);
    expect(await errOf(vf.write('l.md', 'neu', sha('anders')))).toBeInstanceOf(NotUtf8Error);
    expect((await readFile(path.join(root, 'l.md'))).equals(latin1)).toBe(true);
  });
  it('gültiges UTF-8 mit BOM bleibt erlaubt', async () => {
    await writeFile(path.join(root, 'b.md'), Buffer.from('\ufeffä', 'utf8'));
    expect((await vf.read('b.md')).content).toBe('\ufeffä');
  });
});

describe('read', () => {
  it('liefert Inhalt und sha256-Version', async () => {
    await writeFile(path.join(root, 'a.md'), 'hallo');
    expect(await vf.read('a.md')).toEqual({ content: 'hallo', version: sha('hallo') });
  });
  it('verweigert versteckte und ausgeschlossene Pfade', async () => {
    await mkdir(path.join(root, '.git'));
    await writeFile(path.join(root, '.git', 'c'), 'x');
    await mkdir(path.join(root, 'Privat'));
    await writeFile(path.join(root, 'Privat', 'a.md'), 'x');
    await mkdir(path.join(root, 'Homelab', '.x'), { recursive: true });
    await writeFile(path.join(root, 'Homelab', '.x', 'a.md'), 'x');
    expect(await codeOf(vf.read('.git/c'))).toBe('HIDDEN');
    expect(await codeOf(vf.read('Privat/a.md'))).toBe('EXCLUDED');
    expect(await codeOf(vf.read('Homelab/.x/a.md'))).toBe('HIDDEN');
    expect(await codeOf(vf.read('../x'))).toBe('OUTSIDE');
    expect(await codeOf(vf.readBytes('.git/c'))).toBe('HIDDEN');
  });
  it('CRLF und BOM bleiben beim Zurückschreiben bytegleich', async () => {
    const bytes = Buffer.from('﻿---\r\ntitle: x\r\n---\r\nZeile\r\n', 'utf8');
    await writeFile(path.join(root, 'crlf.md'), bytes);
    const { content, version } = await vf.read('crlf.md');
    expect(content.startsWith('﻿')).toBe(true);
    expect(content).toContain('\r\n');
    await vf.write('crlf.md', content, version);
    expect((await readFile(path.join(root, 'crlf.md'))).equals(bytes)).toBe(true);
  });
  it('readBytes liefert Stream, Größe und MIME', async () => {
    await writeFile(path.join(root, 'b.png'), Buffer.from([1, 2, 3]));
    await writeFile(path.join(root, 'z.unbekannt'), 'x');
    const r = await vf.readBytes('b.png');
    expect(r.size).toBe(3);
    expect(r.mime).toBe('image/png');
    const chunks: Buffer[] = [];
    for await (const c of r.stream) chunks.push(c as Buffer);
    expect(Buffer.concat(chunks)).toEqual(Buffer.from([1, 2, 3]));
    expect((await vf.readBytes('z.unbekannt')).mime).toBe('application/octet-stream');
    (await vf.readBytes('z.unbekannt')).stream.destroy();
  });
});

describe('write', () => {
  it('schreibt bei passender Version und liefert die neue', async () => {
    await writeFile(path.join(root, 'a.md'), 'alt');
    const v = await vf.write('a.md', 'neu', sha('alt'));
    expect(v).toBe(sha('neu'));
    expect(await readFile(path.join(root, 'a.md'), 'utf8')).toBe('neu');
  });
  it('wirft ConflictError mit Platteninhalt bei veralteter Version, Datei unverändert', async () => {
    await writeFile(path.join(root, 'a.md'), 'extern geändert');
    const e = await errOf(vf.write('a.md', 'neu', sha('alt')));
    expect(e).toBeInstanceOf(ConflictError);
    expect((e as ConflictError).diskContent).toBe('extern geändert');
    expect((e as ConflictError).diskVersion).toBe(sha('extern geändert'));
    expect(await readFile(path.join(root, 'a.md'), 'utf8')).toBe('extern geändert');
    expect((await readdir(root)).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });
  it('wirft ConflictError(null) wenn die Datei extern gelöscht wurde', async () => {
    const e = await errOf(vf.write('weg.md', 'neu', sha('alt')));
    expect(e).toBeInstanceOf(ConflictError);
    expect((e as ConflictError).diskContent).toBeNull();
    expect((e as ConflictError).diskVersion).toBeNull();
    await expect(stat(path.join(root, 'weg.md'))).rejects.toThrow();
  });
  it('zeigt nie eine halbe Zieldatei; Temp-Dateien sind versteckt (.<name>.<hex>.vwtmp) und verschwinden', async () => {
    const oldC = 'a'.repeat(5_000_000);
    const newC = 'b'.repeat(5_000_000);
    await writeFile(path.join(root, 'big.md'), oldC);
    let done = false;
    const seen = new Set<string>();
    const poller = (async () => {
      while (!done) {
        for (const n of await readdir(root)) {
          if (n === 'big.md') {
            const c = await readFile(path.join(root, n), 'utf8');
            expect([oldC, newC]).toContain(c);
          } else seen.add(n);
        }
      }
    })();
    await vf.write('big.md', newC, sha(oldC));
    done = true;
    await poller;
    for (const n of seen) expect(n).toMatch(/^\.big\.md\.[0-9a-f]{12}\.vwtmp$/);
    expect(await readdir(root)).toEqual(['big.md']);
  });
  it('verweigert readonly (READONLY), versteckt, ausgeschlossen', async () => {
    await mkdir(path.join(root, 'Homelab'));
    await writeFile(path.join(root, 'Homelab', 'n.md'), 'x');
    await mkdir(path.join(root, 'Privat'));
    await writeFile(path.join(root, 'Privat', 'n.md'), 'x');
    await mkdir(path.join(root, '.obsidian'));
    await writeFile(path.join(root, '.obsidian', 'app.json'), 'x');
    expect(await codeOf(vf.write('Homelab/n.md', 'y', sha('x')))).toBe('READONLY');
    expect(await codeOf(vf.create('Homelab/neu.md', 'y'))).toBe('READONLY');
    expect(await codeOf(vf.mkdir('Homelab/sub'))).toBe('READONLY');
    expect(await codeOf(vf.writeBinary('Homelab/x.png', Buffer.from('y')))).toBe('READONLY');
    expect(await codeOf(vf.write('Privat/n.md', 'y', sha('x')))).toBe('EXCLUDED');
    expect(await codeOf(vf.write('.obsidian/app.json', 'y', sha('x')))).toBe('HIDDEN');
    expect(await readFile(path.join(root, 'Homelab', 'n.md'), 'utf8')).toBe('x');
  });
  it('behält den Modus einer bestehenden Datei', async () => {
    await writeFile(path.join(root, 'a.md'), 'x', { mode: 0o640 });
    await vf.write('a.md', 'y', sha('x'));
    expect((await stat(path.join(root, 'a.md'))).mode & 0o777).toBe(0o640);
  });
});

describe('create / mkdir / writeBinary / uniquePath', () => {
  it('create legt Datei an (Modus 0664, Elternordner 0775) und liefert Version', async () => {
    const v = await vf.create('neu/tief/n.md', 'inhalt');
    expect(v).toBe(sha('inhalt'));
    expect((await stat(path.join(root, 'neu/tief/n.md'))).mode & 0o777).toBe(0o664);
    expect((await stat(path.join(root, 'neu/tief'))).mode & 0o777).toBe(0o775);
    expect((await readdir(path.join(root, 'neu/tief')))).toEqual(['n.md']);
  });
  it('create auf existierende Datei wirft ConflictError, Inhalt bleibt', async () => {
    await writeFile(path.join(root, 'a.md'), 'alt');
    const e = await errOf(vf.create('a.md', 'neu'));
    expect(e).toBeInstanceOf(ConflictError);
    expect((e as ConflictError).diskContent).toBe('alt');
    expect(await readFile(path.join(root, 'a.md'), 'utf8')).toBe('alt');
    expect((await readdir(root)).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });
  it('mkdir legt Ordner mit 0775 an', async () => {
    await vf.mkdir('x/y');
    expect((await stat(path.join(root, 'x/y'))).mode & 0o777).toBe(0o775);
    await vf.mkdir('x/y');
  });
  it('writeBinary schreibt Bytes (0664) und überschreibt nie', async () => {
    await vf.writeBinary('assets/b.bin', Buffer.from([9, 8]));
    expect(await readFile(path.join(root, 'assets/b.bin'))).toEqual(Buffer.from([9, 8]));
    expect((await stat(path.join(root, 'assets/b.bin'))).mode & 0o777).toBe(0o664);
    expect(await errOf(vf.writeBinary('assets/b.bin', Buffer.from([1])))).toBeInstanceOf(ConflictError);
    expect(await readFile(path.join(root, 'assets/b.bin'))).toEqual(Buffer.from([9, 8]));
  });
  it('uniquePath hängt Zähler vor die Endung', async () => {
    expect(await vf.uniquePath('a/x.md')).toBe('a/x.md');
    await mkdir(path.join(root, 'a'));
    await writeFile(path.join(root, 'a', 'x.md'), '1');
    expect(await vf.uniquePath('a/x.md')).toBe('a/x 1.md');
    await writeFile(path.join(root, 'a', 'x 1.md'), '1');
    expect(await vf.uniquePath('a/x.md')).toBe('a/x 2.md');
    await writeFile(path.join(root, 'a', 'ohne'), '1');
    expect(await vf.uniquePath('a/ohne')).toBe('a/ohne 1');
  });
});

describe('NFD-Namen auf der Platte', () => {
  const nfdDir = 'U\u0308bersicht';
  const nfdFile = 'a\u0308.md';
  beforeEach(async () => {
    await mkdir(path.join(root, nfdDir));
    await writeFile(path.join(root, nfdDir, nfdFile), 'alt');
  });
  it('read/write über den NFC-Pfad aus tree()', async () => {
    const t = await vf.tree();
    const p = t.children![0]!.children![0]!.path;
    expect(p).toBe('\u00dcbersicht/\u00e4.md');
    expect(await vf.read(p)).toEqual({ content: 'alt', version: sha('alt') });
    expect(await vf.write(p, 'neu', sha('alt'))).toBe(sha('neu'));
    expect(await readFile(path.join(root, nfdDir, nfdFile), 'utf8')).toBe('neu');
    expect((await vf.readBytes(p)).size).toBe(3);
    (await vf.readBytes(p)).stream.destroy();
  });
  it('create in NFD-Ordner legt keinen NFC-Zwilling an', async () => {
    await vf.create('\u00dcbersicht/neu.md', 'x');
    expect(await readdir(root)).toEqual([nfdDir]);
    expect((await readdir(path.join(root, nfdDir))).sort()).toEqual([nfdFile, 'neu.md']);
    await vf.writeBinary('\u00dcbersicht/b.bin', Buffer.from([1]));
    expect(await readdir(root)).toEqual([nfdDir]);
  });
  it('uniquePath erkennt vorhandenen NFD-Namen', async () => {
    expect(await vf.uniquePath('\u00dcbersicht/\u00e4.md')).toBe('\u00dcbersicht/\u00e4 1.md');
  });
});

describe('Ordner als Datei', () => {
  it('read/readBytes auf Ordner werfen NotAFileError', async () => {
    await mkdir(path.join(root, 'ordner'));
    expect(await errOf(vf.read('ordner'))).toBeInstanceOf(NotAFileError);
    expect(await errOf(vf.readBytes('ordner'))).toBeInstanceOf(NotAFileError);
  });
});

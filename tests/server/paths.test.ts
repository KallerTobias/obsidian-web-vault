import { mkdtemp, mkdir, rm, symlink, writeFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PathError, VaultPaths, normalizeRel } from '../../server/vault/paths';

let base: string;
let root: string;
let outside: string;
let vp: VaultPaths;

beforeEach(async () => {
  base = await realpath(await mkdtemp(path.join(tmpdir(), 'vw-paths-')));
  root = path.join(base, 'vault');
  outside = path.join(base, 'outside');
  await mkdir(root);
  await mkdir(outside);
  await mkdir(path.join(root, 'a'));
  await writeFile(path.join(root, 'a', 'b.md'), 'x');
  await symlink(outside, path.join(root, 'link'));
  await symlink(path.join(base, 'nowhere'), path.join(root, 'dangling'));
  await symlink(path.join(root, 'a'), path.join(root, 'inner'));
  await mkdir(path.join(root, '.git'));
  await mkdir(path.join(root, 'Privat'));
  await mkdir(path.join(root, '.trash'));
  await symlink(path.join(root, '.git'), path.join(root, 'x-git'));
  await symlink(path.join(root, 'Privat'), path.join(root, 'x-privat'));
  await symlink(path.join(root, '.git'), path.join(root, 'sneaky'));
  vp = new VaultPaths(root, ['Privat/**'], ['Homelab/**']);
});
afterEach(() => rm(base, { recursive: true, force: true }));

async function code(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
  } catch (e) {
    return e instanceof PathError ? e.code : `other:${String(e)}`;
  }
  return undefined;
}

describe('safeResolve', () => {
  it('löst normale und noch nicht existierende Pfade auf', async () => {
    expect(await vp.safeResolve('a/b.md')).toBe(path.join(root, 'a', 'b.md'));
    expect(await vp.safeResolve('a/neu/c.md')).toBe(path.join(root, 'a', 'neu', 'c.md'));
    expect(await vp.safeResolve('')).toBe(root);
  });

  it.each(['../etc/passwd', '/etc/passwd', 'a/../../x', '..', 'a/../..'])('%s -> OUTSIDE', async (p) => {
    expect(await code(vp.safeResolve(p))).toBe('OUTSIDE');
  });

  it('Geschwisterordner mit gleichem Präfix ist OUTSIDE', async () => {
    await mkdir(path.join(base, 'vault-evil'));
    expect(await code(vp.safeResolve('../vault-evil/x.md'))).toBe('OUTSIDE');
  });

  it('NUL-Byte -> OUTSIDE', async () => {
    expect(await code(vp.safeResolve('a/b\0.md'))).toBe('OUTSIDE');
  });

  it('Symlink nach außen -> OUTSIDE', async () => {
    expect(await code(vp.safeResolve('link/x.md'))).toBe('OUTSIDE');
    expect(await code(vp.safeResolve('link'))).toBe('OUTSIDE');
  });

  it('hängender Symlink -> OUTSIDE', async () => {
    expect(await code(vp.safeResolve('dangling'))).toBe('OUTSIDE');
  });

  it('Symlink innerhalb des Vaults ist erlaubt', async () => {
    expect(await vp.safeResolve('inner/b.md')).toBe(path.join(root, 'inner', 'b.md'));
  });

  it('wirft für versteckte Pfade nicht (reine Containment-Prüfung)', async () => {
    expect(await vp.safeResolve('.trash/x.md')).toBe(path.join(root, '.trash', 'x.md'));
  });

  it('NFD-Eingabe wird zu NFC normalisiert', async () => {
    const nfd = 'Übersicht.md';
    expect(await vp.safeResolve(nfd)).toBe(path.join(root, 'Übersicht.md'));
  });
});

describe('Symlink-Umleitung', () => {
  it('Symlink in versteckten Bereich -> HIDDEN', async () => {
    expect(await code(vp.safeResolve('x-git/config'))).toBe('HIDDEN');
    expect(await code(vp.safeResolve('x-git'))).toBe('HIDDEN');
  });
  it('Symlink in ausgeschlossenen Bereich -> EXCLUDED', async () => {
    expect(await code(vp.safeResolve('x-privat/n.md'))).toBe('EXCLUDED');
  });
  it('.trash/ als Löschziel bleibt erlaubt, Umleitung aus .trash nicht', async () => {
    expect(await vp.safeResolve('.trash/x.md')).toBe(path.join(root, '.trash', 'x.md'));
    await rm(path.join(root, '.trash'), { recursive: true });
    await symlink(path.join(root, '.git'), path.join(root, '.trash'));
    expect(await code(vp.safeResolve('.trash/x.md'))).toBe('HIDDEN');
  });
});

describe('Normalisierung', () => {
  it.each(['a/../Privat/x.md', './Privat/x.md', 'Privat/./x.md', 'Privat//x.md'])('%s ist ausgeschlossen', (p) => {
    expect(vp.isExcluded(p)).toBe(true);
    expect(vp.isVisible(p)).toBe(false);
  });
  it.each(['a/../Homelab/x.md', './Homelab/x.md', 'Homelab/./x.md'])('%s ist readonly', (p) => {
    expect(vp.isReadonly(p)).toBe(true);
  });
  it.each(['a/../.git/config', './.git/config', '.git/./config'])('%s ist versteckt', (p) => {
    expect(vp.isHidden(p)).toBe(true);
  });
  it('normalizeRel kanonisiert und lehnt Ausbruch ab', () => {
    expect(normalizeRel('./a//b/')).toBe('a/b');
    expect(normalizeRel('a/..')).toBe('');
    expect(() => normalizeRel('a/../../x')).toThrow(PathError);
    expect(() => normalizeRel('/x')).toThrow(PathError);
    expect(() => normalizeRel('a\0')).toThrow(PathError);
    expect(vp.normalizeRel('U\u0308/x')).toBe('\u00dc/x');
  });
});

describe('Klassifizierung', () => {
  it('isHidden', () => {
    expect(vp.isHidden('.git/config')).toBe(true);
    expect(vp.isHidden('a/.obsidian/app.json')).toBe(true);
    expect(vp.isHidden('.trash')).toBe(true);
    expect(vp.isHidden('a/b.md')).toBe(false);
    expect(vp.isHidden('a/b.v1.md')).toBe(false);
  });

  it('isExcluded', () => {
    expect(vp.isExcluded('Privat/Intern/x.md')).toBe(true);
    expect(vp.isExcluded('Privat')).toBe(true);
    expect(vp.isExcluded('Privatim/x.md')).toBe(false);
    expect(vp.isExcluded('a/b.md')).toBe(false);
  });

  it('isReadonly', () => {
    expect(vp.isReadonly('Homelab/a.md')).toBe(true);
    expect(vp.isReadonly('a/b.md')).toBe(false);
  });

  it('isVisible = nicht versteckt und nicht ausgeschlossen', () => {
    expect(vp.isVisible('a/b.md')).toBe(true);
    expect(vp.isVisible('.git/config')).toBe(false);
    expect(vp.isVisible('Privat/x.md')).toBe(false);
    expect(vp.isVisible('Homelab/a.md')).toBe(true);
  });

  it('isVisible blendet *.tmp aus (gemeinsame Regel für Baum und Watcher)', () => {
    expect(vp.isVisible('a/b.md.abc.tmp')).toBe(false);
    expect(vp.isVisible('~syncthing~b.md.tmp')).toBe(false);
    expect(vp.isVisible('x.tmp/b.md')).toBe(false);
    expect(vp.isVisible('a/.b.md.0123456789ab.vwtmp')).toBe(false);
    expect(vp.isVisible('a/tmp.md')).toBe(true);
  });

  it('Globs matchen NFC auch bei NFD-Eingabe; Dotfiles matchen * nicht', () => {
    const v = new VaultPaths(root, ['Über/**'], ['*.md']);
    expect(v.isExcluded('Über/x.md')).toBe(true);
    expect(v.isReadonly('.hidden.md')).toBe(false);
  });
});

describe('PathError', () => {
  it('trägt den Code', () => {
    const e = new PathError('READONLY', 'x');
    expect(e).toBeInstanceOf(Error);
    expect(e.code).toBe('READONLY');
  });
});

describe('safeResolve mit NFD-Namen auf der Platte', () => {
  it('liefert echte Namen für NFC-Eingaben, NFC-Namen für Neues', async () => {
    await mkdir(path.join(root, 'U\u0308ber'));
    await writeFile(path.join(root, 'U\u0308ber', 'a\u0308.md'), 'x');
    expect(await vp.safeResolve('\u00dcber/\u00e4.md')).toBe(path.join(root, 'U\u0308ber', 'a\u0308.md'));
    expect(await vp.safeResolve('\u00dcber/neu.md')).toBe(path.join(root, 'U\u0308ber', 'neu.md'));
    expect(await vp.safeResolve('\u00dcneu/x.md')).toBe(path.join(root, '\u00dcneu', 'x.md'));
  });
});

import { describe, expect, it } from 'vitest';
import { createFileLookup, linkTextFor, resolveLink, type FileLookup } from '@shared/resolve';

function lookup(paths: string[]): FileLookup {
  const byPath = new Map<string, string>();
  const byBasename = new Map<string, string[]>();
  for (const p of paths) {
    byPath.set(p.normalize('NFC').toLowerCase(), p);
    const b = (p.slice(p.lastIndexOf('/') + 1)).normalize('NFC').toLowerCase();
    byBasename.set(b, [...(byBasename.get(b) ?? []), p]);
  }
  return { byPath, byBasename };
}

describe('resolveLink', () => {
  const files = lookup([
    'Notizen/A.md', 'B.md', 'Ordner/Sub/C.md', 'NXTZLT/Geteilt/00 - Übersicht.md',
    'Homelab/Geteilt/00 - Übersicht.md', 'Anhänge/bild.jpg', 'Ordner/D.md', 'Andere/D.md',
  ]);
  it('exact path with and without .md', () => {
    expect(resolveLink('Notizen/A', 'x.md', files)).toBe('Notizen/A.md');
    expect(resolveLink('Notizen/A.md', 'x.md', files)).toBe('Notizen/A.md');
  });
  it('path relative to the source folder', () => {
    expect(resolveLink('Sub/C', 'Ordner/x.md', files)).toBe('Ordner/Sub/C.md');
    expect(resolveLink('../B.md', 'Ordner/x.md', files)).toBe('B.md');
  });
  it('unique basename', () => {
    expect(resolveLink('C', 'x.md', files)).toBe('Ordner/Sub/C.md');
    expect(resolveLink('Sub/C', 'x.md', files)).toBe('Ordner/Sub/C.md');
  });
  it('ambiguous: same folder, then shortest, then alphabetical', () => {
    expect(resolveLink('00 - Übersicht', 'NXTZLT/Geteilt/n.md', files)).toBe('NXTZLT/Geteilt/00 - Übersicht.md');
    expect(resolveLink('00 - Übersicht', 'Homelab/Geteilt/n.md', files)).toBe('Homelab/Geteilt/00 - Übersicht.md');
    expect(resolveLink('00 - Übersicht', 'Irgendwo/n.md', files)).toBe('NXTZLT/Geteilt/00 - Übersicht.md');
    expect(resolveLink('D', 'x.md', files)).toBe('Andere/D.md');
  });
  it('is case-insensitive', () => {
    expect(resolveLink('notizen/a', 'x.md', files)).toBe('Notizen/A.md');
    expect(resolveLink('BILD.JPG', 'x.md', files)).toBe('Anhänge/bild.jpg');
  });
  it('finds attachments by basename with extension', () => {
    expect(resolveLink('bild.jpg', 'Ordner/x.md', files)).toBe('Anhänge/bild.jpg');
  });
  it('finds NFD file names from NFC links', () => {
    const nfd = lookup(['Übersicht.md'.normalize('NFD')]);
    expect(resolveLink('Übersicht', 'x.md', nfd)).toBe('Übersicht.md'.normalize('NFD'));
  });
  it('returns null when nothing matches', () => {
    expect(resolveLink('Gibtsnicht', 'x.md', files)).toBeNull();
    expect(resolveLink('', 'x.md', files)).toBeNull();
  });
});

describe('linkTextFor', () => {
  const files = lookup(['Notizen/A.md', 'B/Dup.md', 'C/Dup.md', 'Anhänge/bild.jpg']);
  it('shortest', () => {
    expect(linkTextFor('Notizen/A.md', 'x.md', files, 'shortest')).toBe('A');
    expect(linkTextFor('B/Dup.md', 'x.md', files, 'shortest')).toBe('B/Dup');
    expect(linkTextFor('Anhänge/bild.jpg', 'x.md', files, 'shortest')).toBe('bild.jpg');
  });
  it('absolute and relative', () => {
    expect(linkTextFor('Notizen/A.md', 'x.md', files, 'absolute')).toBe('Notizen/A');
    expect(linkTextFor('Notizen/A.md', 'Notizen/x.md', files, 'relative')).toBe('A');
    expect(linkTextFor('Notizen/A.md', 'B/x.md', files, 'relative')).toBe('../Notizen/A');
  });
});

describe('createFileLookup', () => {
  it('builds the same tables as the server index (NFC + lowercase keys)', () => {
    const paths = ['A/Übersicht.md', 'B/übersicht.md', 'Bild.PNG'];
    const lk = createFileLookup(paths);
    expect(lk).toEqual(lookup(paths));
    expect(resolveLink('Bild.png', 'x.md', lk)).toBe('Bild.PNG');
  });
});

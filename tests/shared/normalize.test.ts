import { describe, expect, it } from 'vitest';
import { basename, dirname, joinPath, nfc, relativeTo, stripMd } from '@shared/normalize';

describe('normalize', () => {
  it('nfc composes decomposed characters', () => {
    expect(nfc('Ü')).toBe('Ü');
    expect(nfc('Ü') === 'Ü').toBe(true);
  });
  it('joinPath collapses slashes', () => {
    expect(joinPath('a/', '/b', 'c.md')).toBe('a/b/c.md');
  });
  it('joinPath normalizes to NFC', () => {
    expect(joinPath('Übersicht', 'x.md')).toBe('Übersicht/x.md');
  });
  it('dirname / basename', () => {
    expect(dirname('a/b/c.md')).toBe('a/b');
    expect(dirname('c.md')).toBe('');
    expect(basename('a/b/c.md')).toBe('c.md');
  });
  it('stripMd removes only a trailing .md', () => {
    expect(stripMd('a/B.md')).toBe('a/B');
    expect(stripMd('a/B.txt')).toBe('a/B.txt');
  });
});

describe('relativeTo', () => {
  it('joins a target to a folder, resolving . and ..', () => {
    expect(relativeTo('A/B', 'C.md')).toBe('A/B/C.md');
    expect(relativeTo('A/B', './C.md')).toBe('A/B/C.md');
    expect(relativeTo('A/B', '../C.md')).toBe('A/C.md');
    expect(relativeTo('', 'C.md')).toBe('C.md');
  });

  it('a leading / is the vault root; never goes above the root', () => {
    expect(relativeTo('A/B', '/C.md')).toBe('C.md');
    expect(relativeTo('A', '../../../C.md')).toBe('C.md');
  });
});

import { beforeEach, describe, expect, it } from 'vitest';
import { SearchIndex } from '../../server/index/search';

describe('SearchIndex', () => {
  let idx: SearchIndex;
  beforeEach(() => {
    idx = new SearchIndex();
    idx.upsert('Camping/Dachzelt.md', 'Das Dachzelt ist toll.\nZweite Zeile mit Käse und Wasser.', ['camping', 'gear/zelt']);
    idx.upsert('Camping/Packliste.md', 'Wir packen ein Zelt, Kaese und Brot.\nNichts weiter', ['camping']);
    idx.upsert('Homelab/Intern/Übersicht.md', 'Server und Netzwerk im Überblick', ['nxtzlt']);
    idx.upsert('Homelab/Geteilt/Notiz.md', 'Der alte Server wurde abgeschaltet', []);
  });
  const paths = (q: string) => idx.search(q).map((h) => h.path);

  it('matches word prefixes', () => {
    expect(paths('Dachz')).toEqual(['Camping/Dachzelt.md']);
  });
  it('ignores case and diacritics', () => {
    expect(paths('KASE')).toContain('Camping/Dachzelt.md');
    expect(paths('käse')).toContain('Camping/Dachzelt.md');
    expect(paths('uberblick')).toEqual(['Homelab/Intern/Übersicht.md']);
  });
  it('phrases only match the exact sequence', () => {
    expect(paths('"zelt, kaese"')).toEqual(['Camping/Packliste.md']);
    expect(paths('"kaese zelt"')).toEqual([]);
  });
  it('excludes with -word', () => {
    expect(paths('server -alte')).toEqual(['Homelab/Intern/Übersicht.md']);
  });
  it('path: is a prefix on the path', () => {
    expect(paths('server path:Homelab/Geteilt')).toEqual(['Homelab/Geteilt/Notiz.md']);
    expect(paths('server path:Geteilt')).toEqual([]);
  });
  it('tag: includes subtags', () => {
    expect(paths('tag:gear')).toEqual(['Camping/Dachzelt.md']);
    expect(paths('tag:#gear/zelt')).toEqual(['Camping/Dachzelt.md']);
    expect(paths('tag:camping')).toEqual(['Camping/Dachzelt.md', 'Camping/Packliste.md']);
  });
  it('file: matches the file name', () => {
    expect(paths('file:ubersicht')).toEqual(['Homelab/Intern/Übersicht.md']);
    expect(paths('server file:notiz')).toEqual(['Homelab/Geteilt/Notiz.md']);
  });
  it('hits carry 0-based line and character ranges', () => {
    const hit = idx.search('Dachzelt')[0]!;
    expect(hit.matches[0]).toEqual({ line: 0, text: 'Das Dachzelt ist toll.', ranges: [[4, 12]] });
    const k = idx.search('käse').find((h) => h.path === 'Camping/Dachzelt.md')!;
    expect(k.matches[0]).toMatchObject({ line: 1, ranges: [[17, 21]] });
  });
  it('operators only: all matching notes sorted by path', () => {
    expect(paths('path:Homelab')).toEqual(['Homelab/Geteilt/Notiz.md', 'Homelab/Intern/Übersicht.md']);
    expect(paths('-tag:camping')).toEqual(['Homelab/Geteilt/Notiz.md', 'Homelab/Intern/Übersicht.md']);
    expect(paths('')).toEqual([]);
  });
  it('upsert replaces, remove deletes, limit applies', () => {
    idx.upsert('Camping/Dachzelt.md', 'jetzt etwas anderes', []);
    expect(idx.search('Das')).toEqual([]);
    expect(paths('anderes')).toEqual(['Camping/Dachzelt.md']);
    idx.remove('Camping/Dachzelt.md');
    expect(paths('anderes')).toEqual([]);
    idx.remove('gibt-es-nicht.md');
    expect(idx.search('server', 1)).toHaveLength(1);
  });
  it('normalizes NFD input paths/text', () => {
    idx.upsert('Ordner/Übung.md', 'Käse', []);
    expect(paths('käse')).toContain('Ordner/Übung.md');
  });
});

describe('SearchIndex word-start matching', () => {
  const make = () => {
    const idx = new SearchIndex();
    idx.upsert('a.md', 'Der Start der Planung ist alt', []);
    idx.upsert('b.md', 'Die Karte wird verwaltet, planung läuft', []);
    idx.upsert('c.md', 'nichts hier planung', []);
    return idx;
  };
  const paths = (idx: SearchIndex, q: string) => idx.search(q).map((h) => h.path).sort();
  it('-art keeps notes containing Start/Karte', () => {
    expect(paths(make(), 'planung -art')).toEqual(['a.md', 'b.md', 'c.md']);
  });
  it('-alte keeps verwaltet but excludes alt-prefixed words', () => {
    expect(paths(make(), 'planung -alte')).toEqual(['a.md', 'b.md', 'c.md']);
    expect(paths(make(), 'planung -alt')).toEqual(['b.md', 'c.md']);
  });
  it('-plan excludes Planung (prefix at word end allowed)', () => {
    expect(paths(make(), 'karte -plan')).toEqual([]);
  });
  it('negated phrase', () => {
    expect(paths(make(), 'planung -"der start"')).toEqual(['b.md', 'c.md']);
    expect(paths(make(), 'planung -"er start"')).toEqual(['a.md', 'b.md', 'c.md']);
  });
  it('phrase only mid-word is not a hit', () => {
    expect(paths(make(), '"tart der"')).toEqual([]);
    expect(paths(make(), '"start der"')).toEqual(['a.md']);
  });
  it('CRLF text gives correct line and ranges', () => {
    const idx = new SearchIndex();
    idx.upsert('crlf.md', 'erste\r\nzweite Zeile mit Käse\r\nende', []);
    expect(idx.search('käse')[0]!.matches).toEqual([{ line: 1, text: 'zweite Zeile mit Käse', ranges: [[17, 21]] }]);
  });
});

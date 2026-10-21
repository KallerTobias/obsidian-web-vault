import { describe, expect, it } from 'vitest';
import { matchesMeta, parseQuery } from '@shared/query';

describe('parseQuery', () => {
  it('parses text, phrases, negation and operators', () => {
    expect(parseQuery('foo "a b" -bar path:"Homelab/Intern" tag:#nxtzlt file:Übersicht -tag:x')).toEqual([
      { kind: 'text', value: 'foo', phrase: false, negate: false },
      { kind: 'text', value: 'a b', phrase: true, negate: false },
      { kind: 'text', value: 'bar', phrase: false, negate: true },
      { kind: 'path', value: 'Homelab/Intern', phrase: true, negate: false },
      { kind: 'tag', value: 'nxtzlt', phrase: false, negate: false },
      { kind: 'file', value: 'Übersicht', phrase: false, negate: false },
      { kind: 'tag', value: 'x', phrase: false, negate: true },
    ]);
  });
  it('tag:x equals tag:#x', () => {
    expect(parseQuery('tag:x')).toEqual(parseQuery('tag:#x'));
  });
  it('handles empty input, lone dash and unterminated quotes', () => {
    expect(parseQuery('   ')).toEqual([]);
    expect(parseQuery('-')).toEqual([]);
    expect(parseQuery('"abc')).toEqual([{ kind: 'text', value: 'abc', phrase: true, negate: false }]);
  });
  it('normalizes values to NFC', () => {
    expect(parseQuery('file:Übersicht')[0]?.value).toBe('Übersicht');
  });
});

describe('matchesMeta', () => {
  const meta = { path: 'Homelab/Intern/Übersicht.md', name: 'Übersicht', tags: ['nxtzlt/a', 'x'] };
  it('text terms test the name only, case/diacritics-insensitive', () => {
    expect(matchesMeta(parseQuery('ubersi'), meta)).toBe(true);
    expect(matchesMeta(parseQuery('homelab'), meta)).toBe(false);
    expect(matchesMeta(parseQuery('-homelab'), meta)).toBe(true);
  });
  it('path prefix, tag incl. subtags, file', () => {
    expect(matchesMeta(parseQuery('path:homelab/intern'), meta)).toBe(true);
    expect(matchesMeta(parseQuery('path:Intern'), meta)).toBe(false);
    expect(matchesMeta(parseQuery('tag:nxtzlt'), meta)).toBe(true);
    expect(matchesMeta(parseQuery('tag:nxt'), meta)).toBe(false);
    expect(matchesMeta(parseQuery('-tag:x'), meta)).toBe(false);
    expect(matchesMeta(parseQuery('file:übers'), meta)).toBe(true);
  });
  it('empty query matches everything', () => {
    expect(matchesMeta([], meta)).toBe(true);
  });
});

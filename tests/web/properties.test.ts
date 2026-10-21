import { describe, expect, it } from 'vitest';
import { addListItems, inferPropertyType, listValue, readProperties } from '../../web/src/lib/properties';

describe('inferPropertyType', () => {
  it('knows tags and aliases by key', () => {
    expect(inferPropertyType('tags', ['a', 'b'])).toBe('tags');
    expect(inferPropertyType('tags', 'a, b')).toBe('tags');
    expect(inferPropertyType('aliases', ['A'])).toBe('list');
    expect(inferPropertyType('cssclasses', 'wide')).toBe('list');
  });

  it('infers the type from the value', () => {
    expect(inferPropertyType('quellen', ['x', 'y'])).toBe('list');
    expect(inferPropertyType('seiten', 42)).toBe('number');
    expect(inferPropertyType('erledigt', true)).toBe('checkbox');
    expect(inferPropertyType('last_verified', '2026-10-16')).toBe('date');
    expect(inferPropertyType('termin', '2026-10-16T09:30')).toBe('datetime');
    expect(inferPropertyType('termin', '2026-10-16T09:30:15')).toBe('datetime');
    expect(inferPropertyType('confidence', 'verified')).toBe('text');
    expect(inferPropertyType('leer', null)).toBe('text');
    expect(inferPropertyType('datum', '2026-13-99 und mehr')).toBe('text');
    expect(inferPropertyType('datum', '2026-13-01')).toBe('text');
    expect(inferPropertyType('datum', '2026-02-31')).toBe('text');
    expect(inferPropertyType('datum', '2028-02-29')).toBe('date');
    expect(inferPropertyType('termin', '2026-10-16T09:30:00Z')).toBe('datetime');
    expect(inferPropertyType('termin', '2026-10-16T09:30+02:00')).toBe('datetime');
    expect(inferPropertyType('termin', '2026-10-16T25:30')).toBe('text');
  });
});

describe('listValue / addListItems', () => {
  it('normalises list values', () => {
    expect(listValue(['a', 2])).toEqual(['a', '2']);
    expect(listValue('a, b')).toEqual(['a', 'b']);
    expect(listValue(null)).toEqual([]);
    expect(listValue('#x #y', true)).toEqual(['x', 'y']);
  });

  it('adds comma-separated items, strips # for tags and skips duplicates', () => {
    expect(addListItems(['a'], 'b, c ,a', false)).toEqual(['a', 'b', 'c']);
    expect(addListItems([], '#projekt/x, #neu', true)).toEqual(['projekt/x', 'neu']);
    expect(addListItems(['a'], '  ', false)).toEqual(['a']);
  });
});

describe('readProperties', () => {
  it('lists the frontmatter keys in order', () => {
    expect(readProperties('---\nb: 1\na: x\n---\nText')).toEqual({ state: 'ok', entries: [['b', 1], ['a', 'x']] });
  });
  it('reports a missing and an invalid block', () => {
    expect(readProperties('Text')).toEqual({ state: 'none' });
    expect(readProperties('---\na: [\n---\n').state).toBe('invalid');
  });
});

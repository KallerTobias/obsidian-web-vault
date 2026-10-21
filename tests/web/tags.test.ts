import { describe, expect, it } from 'vitest';
import { isValidNoteName } from '../../web/src/lib/names';
import { buildTagTree } from '../../web/src/lib/tags';

describe('buildTagTree', () => {
  it('nests a/b/c and sums counts into the parents', () => {
    const tree = buildTagTree([
      { tag: 'projekt', count: 2 },
      { tag: 'projekt/alpha', count: 3 },
      { tag: 'projekt/alpha/todo', count: 1 },
      { tag: 'privat/gesundheit', count: 4 },
    ]);
    expect(tree.map((n) => [n.name, n.count, n.own])).toEqual([
      ['privat', 4, 0],
      ['projekt', 6, 2],
    ]);
    const alpha = tree[1]!.children[0]!;
    expect(alpha).toMatchObject({ name: 'alpha', tag: 'projekt/alpha', count: 4, own: 3 });
    expect(alpha.children[0]).toMatchObject({ name: 'todo', tag: 'projekt/alpha/todo', count: 1 });
  });

  it('sorts siblings by name, locale-aware', () => {
    const names = buildTagTree([
      { tag: 'zebra', count: 1 },
      { tag: 'Ärger', count: 1 },
      { tag: 'apfel', count: 1 },
    ]).map((n) => n.name);
    expect(names).toEqual(['apfel', 'Ärger', 'zebra']);
  });

  it('ignores empty segments', () => {
    expect(buildTagTree([{ tag: 'a//b/', count: 1 }])[0]).toMatchObject({ tag: 'a', children: [{ tag: 'a/b', own: 1 }] });
  });
});

describe('isValidNoteName', () => {
  it('rejects empty, dotted and special-character names', () => {
    expect(isValidNoteName('Plan 2')).toBe(true);
    expect(isValidNoteName('')).toBe(false);
    expect(isValidNoteName('.versteckt')).toBe(false);
    for (const bad of ['a/b', 'a#b', 'a^b', 'a[b', 'a]b', 'a|b', 'a:b', 'a?b']) expect(isValidNoteName(bad)).toBe(false);
  });
});

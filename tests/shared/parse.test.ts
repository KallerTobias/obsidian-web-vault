import { describe, expect, it } from 'vitest';
import { parse as yamlParse } from 'yaml';
import { parseNote } from '@shared/parse';

describe('parseNote links', () => {
  it('parses plain wikilink', () => {
    const t = 'x [[A]] y';
    const { links } = parseNote(t);
    expect(links).toEqual([
      { kind: 'wikilink', target: 'A', raw: '[[A]]', from: 2, to: 7, line: 0 },
    ]);
  });
  it('parses path + alias', () => {
    expect(parseNote('[[Pfad/A|Alias]]').links[0]).toMatchObject({
      kind: 'wikilink', target: 'Pfad/A', alias: 'Alias',
    });
  });
  it('parses heading and block subpaths', () => {
    expect(parseNote('[[A#Kopf]]').links[0]).toMatchObject({ target: 'A', subpath: 'Kopf' });
    expect(parseNote('[[A#^abc]]').links[0]).toMatchObject({ target: 'A', subpath: '^abc' });
    expect(parseNote('[[A#Kopf|x]]').links[0]).toMatchObject({ target: 'A', subpath: 'Kopf', alias: 'x' });
    expect(parseNote('[[#Kopf]]').links[0]).toMatchObject({ target: '', subpath: 'Kopf' });
  });
  it('keeps .md and trims, NFC-normalizes', () => {
    expect(parseNote('[[ A.md ]]').links[0]?.target).toBe('A.md');
    expect(parseNote('[[Übersicht]]').links[0]?.target).toBe('Übersicht');
  });
  it('handles escaped pipe in tables', () => {
    expect(parseNote('| [[A\\|B]] |').links[0]).toMatchObject({ target: 'A', alias: 'B' });
  });
  it('parses embeds', () => {
    expect(parseNote('![[bild.jpg|300]]').links[0]).toMatchObject({
      kind: 'embed', target: 'bild.jpg', alias: '300', raw: '![[bild.jpg|300]]', from: 0,
    });
  });
  it('parses markdown links with decoding', () => {
    expect(parseNote('[t](Ordner/Mein%20Text.md#x)').links[0]).toMatchObject({
      kind: 'markdown', target: 'Ordner/Mein Text.md', subpath: 'x', alias: 't',
    });
    expect(parseNote('[t](<Mein Text.md>)').links[0]).toMatchObject({ target: 'Mein Text.md' });
    expect(parseNote('[t](a%2.md)').links[0]).toMatchObject({ target: 'a%2.md' });
  });
  it('parses markdown image as embed', () => {
    expect(parseNote('![alt](img/a%20b.png)').links[0]).toMatchObject({ kind: 'embed', target: 'img/a b.png' });
  });
  it('emits internal markdown links to non-md targets (attachments)', () => {
    expect(parseNote('[x](file.pdf) [y](Anhang/a%20b.pdf#page=2)').links).toMatchObject([
      { kind: 'markdown', target: 'file.pdf', alias: 'x' },
      { kind: 'markdown', target: 'Anhang/a b.pdf', subpath: 'page=2' },
    ]);
  });
  it('keeps document order when wikilinks and markdown links interleave', () => {
    const t = '[a](a.md) [[B]] [c](c.md) [[D]]';
    expect(parseNote(t).links.map((l) => l.target)).toEqual(['a.md', 'B', 'c.md', 'D']);
  });
  it('ignores external links', () => {
    expect(parseNote('[x](https://example.com/a.md) [m](mailto:a@b.c) [o](obsidian://open)').links).toEqual([]);
  });
  it('ignores links in inline code, fences, comments and math', () => {
    const t = [
      '`[[a]]` and ``[[b]] ` ``',
      '```',
      '[[c]]',
      '```',
      '~~~js',
      '[[d]]',
      '~~~',
      '%%[[e]]%%',
      '%%',
      '[[f]]',
      '%%',
      '$[[g]]$ $$[[h]]$$',
      '$$',
      '[[i]]',
      '$$',
      '[[ok]]',
    ].join('\n');
    expect(parseNote(t).links.map((l) => l.target)).toEqual(['ok']);
  });
  it('does not treat prices as math', () => {
    expect(parseNote('costs $5 and $6 [[A]]').links).toHaveLength(1);
  });
  it('a longer fence is not closed by a shorter one', () => {
    const t = '````\n```\n[[a]]\n```\n````\n[[b]]';
    expect(parseNote(t).links.map((l) => l.target)).toEqual(['b']);
  });
  it('counts lines correctly across skipped plain lines', () => {
    const t = 'plain\nplain two\r\n\nmore text\n[[A]]\nplain\n`x` [[B]]\n';
    expect(parseNote(t).links.map((l) => [l.target, l.line])).toEqual([['A', 4], ['B', 6]]);
  });
  it('reports 0-based lines', () => {
    const l = parseNote('a\n\n[[A]]').links[0];
    expect(l?.line).toBe(2);
  });
});

describe('parseNote tags', () => {
  const tags = (t: string) => parseNote(t).tags.map((x) => x.tag);
  it('recognizes valid tags', () => {
    expect(tags('#a #a/b #ä-ö_1 text #x')).toEqual(['a', 'a/b', 'ä-ö_1', 'x']);
  });
  it('gives offsets of the tag incl. #', () => {
    const t = 'ab #tag!';
    expect(parseNote(t).tags[0]).toEqual({ tag: 'tag', from: 3, to: 7, source: 'body' });
  });
  it('rejects digit-only, URL, heading and escaped hashes', () => {
    expect(tags('#1 #123')).toEqual([]);
    expect(tags('https://x.de/a#frag and [[A#Kopf]] and [t](a.md#x)')).toEqual([]);
    expect(tags('# Titel\n## Zwei')).toEqual([]);
    expect(tags('\\#nope a#b')).toEqual([]);
  });
  it('handles non-BMP letters and mixed digit tags', () => {
    expect(tags('#\u{1D4D0}b #2026 #2026-q1 #1a')).toEqual(['\u{1D4D0}b', '2026-q1', '1a']);
  });
  it('ignores tags in code and comments', () => {
    expect(tags('`#a` %%#b%%\n```\n#c\n```\n#d')).toEqual(['d']);
  });
  it('finds tags in headings text', () => {
    expect(tags('# Titel #foo')).toEqual(['foo']);
  });
  it('reads frontmatter tags in all forms', () => {
    const fm = (y: string) => parseNote(`---\n${y}\n---\nbody`).tags;
    for (const y of ['tags: [x, y]', 'tags: x, y', 'tags: x y', 'tags:\n  - x\n  - "#y"', 'tag: [x, y]']) {
      const r = fm(y);
      expect(r.map((t) => t.tag), y).toEqual(['x', 'y']);
      expect(r.every((t) => t.source === 'frontmatter')).toBe(true);
    }
    expect(fm('tags: x').map((t) => t.tag)).toEqual(['x']);
  });
  it('points frontmatter tag offsets at the value', () => {
    const t = '---\ntags: [foo]\n---\n';
    const tag = parseNote(t).tags[0]!;
    expect(t.slice(tag.from, tag.to)).toBe('foo');
  });
  it('does not scan frontmatter body for body tags', () => {
    expect(parseNote('---\ntitle: "#nope"\n---\n#yes').tags.map((x) => x.tag)).toEqual(['yes']);
  });
});

describe('parseNote headings and block ids', () => {
  it('parses headings 1-6', () => {
    const t = '# A\n## B ##\n###### F\n####### no\n#nospace\n    # indented code';
    const h = parseNote(t).headings;
    expect(h).toEqual([
      { level: 1, text: 'A', line: 0, from: 0 },
      { level: 2, text: 'B', line: 1, from: 4 },
      { level: 6, text: 'F', line: 2, from: 12 },
    ]);
  });
  it('skips headings in fences', () => {
    expect(parseNote('```\n# x\n```\n# y').headings.map((h) => h.text)).toEqual(['y']);
  });
  it('finds block ids at line end', () => {
    expect(parseNote('text ^abc\nmore ^d-1  \n^solo\nnot ^mid here\n`x ^code`').blockIds).toEqual(['abc', 'd-1', 'solo']);
  });
});

describe('parseNote frontmatter', () => {
  it('parses yaml and range', () => {
    const t = '---\ntitle: Hi\naliases: [A, B]\n---\nbody';
    const r = parseNote(t);
    expect(r.frontmatter).toEqual({ title: 'Hi', aliases: ['A', 'B'] });
    expect(r.aliases).toEqual(['A', 'B']);
    expect(t.slice(r.frontmatterRange!.from, r.frontmatterRange!.to)).toBe('---\ntitle: Hi\naliases: [A, B]\n---');
  });
  it('accepts alias as string and `...` as closer', () => {
    const r = parseNote('---\nalias: "X, Y"\n...\nbody');
    expect(r.aliases).toEqual(['X', 'Y']);
    expect(r.frontmatterRange).not.toBeNull();
  });
  it('only recognizes frontmatter on the very first line', () => {
    const r = parseNote('\n---\na: 1\n---\n');
    expect(r.frontmatter).toBeNull();
    expect(r.frontmatterRange).toBeNull();
  });
  it('requires a closing line', () => {
    expect(parseNote('---\na: 1\n').frontmatterRange).toBeNull();
  });
  it('invalid yaml: null frontmatter, range set, no throw', () => {
    const r = parseNote('---\na: [1\nb: : :\n---\n[[A]]');
    expect(r.frontmatter).toBeNull();
    expect(r.frontmatterRange).not.toBeNull();
    expect(r.aliases).toEqual([]);
    expect(r.links).toHaveLength(1);
  });
  it('non-mapping yaml gives null; empty gives {}', () => {
    expect(parseNote('---\n- a\n- b\n---\n').frontmatter).toBeNull();
    expect(parseNote('---\n---\n').frontmatter).toEqual({});
  });
  it('does not parse links in frontmatter', () => {
    expect(parseNote('---\nrel: "[[A]]"\n---\n[[B]]').links.map((l) => l.target)).toEqual(['B']);
  });
  it('handles BOM', () => {
    const t = '﻿---\na: 1\n---\n# H';
    const r = parseNote(t);
    expect(r.frontmatter).toEqual({ a: 1 });
    expect(r.frontmatterRange!.from).toBe(1);
    expect(r.headings[0]).toMatchObject({ text: 'H', line: 3 });
    expect(parseNote('﻿# H').headings[0]).toMatchObject({ from: 1, line: 0 });
  });
});

describe('parseNote CRLF', () => {
  it('gives correct offsets, lines and text', () => {
    const t = '---\r\ntags: [x]\r\n---\r\n# Kopf\r\ntext [[A|b]] #t ^id\r\n';
    const r = parseNote(t);
    const l = r.links[0]!;
    expect(t.slice(l.from, l.to)).toBe('[[A|b]]');
    expect(l.line).toBe(4);
    expect(r.headings[0]).toMatchObject({ text: 'Kopf', line: 3 });
    expect(t.slice(r.headings[0]!.from, r.headings[0]!.from + 6)).toBe('# Kopf');
    const tag = r.tags.find((x) => x.source === 'body')!;
    expect(t.slice(tag.from, tag.to)).toBe('#t');
    expect(r.blockIds).toEqual(['id']);
    expect(t.slice(r.frontmatterRange!.from, r.frontmatterRange!.to)).toBe('---\r\ntags: [x]\r\n---');
    expect(r.frontmatter).toEqual({ tags: ['x'] });
  });
});

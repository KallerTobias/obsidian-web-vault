import { describe, expect, it } from 'vitest';
import { linkedSegments, linkMention, mentionPattern, mentionSegments } from '../../web/src/lib/backlinks';

describe('mentionSegments', () => {
  it('marks whole-word mentions of the name or an alias, case-insensitive', () => {
    const re = mentionPattern(['Projekt Alpha', 'PA'])!;
    expect(mentionSegments('Über projekt alpha und PA, nicht PAX.', re)).toEqual([
      { text: 'Über ', hit: false },
      { text: 'projekt alpha', hit: true },
      { text: ' und ', hit: false },
      { text: 'PA', hit: true },
      { text: ', nicht PAX.', hit: false },
    ]);
  });
  it('keeps text with special characters literal', () => {
    const re = mentionPattern(['C++ (Buch)'])!;
    expect(mentionSegments('<b>C++ (Buch)</b>', re).filter((s) => s.hit)).toEqual([{ text: 'C++ (Buch)', hit: true }]);
  });
});

describe('mentionSegments and links', () => {
  it('does not mark mentions inside links (they are not offered for linking either)', () => {
    const re = mentionPattern(['Ziel'])!;
    expect(mentionSegments('[[Ziel]] und [Ziel](x.md) und Ziel', re).filter((s) => s.hit)).toHaveLength(1);
    expect(mentionSegments('[[Ziel]] und Ziel', re).at(-1)).toEqual({ text: 'Ziel', hit: true });
  });
});

describe('linkedSegments', () => {
  it('marks the links that point to the note', () => {
    const segs = linkedSegments('Siehe [[Ordner/Ziel#Kopf|hier]] und [[Anderes]] sowie [x](Ziel.md).', 'Ordner/Ziel.md');
    expect(segs.filter((s) => s.hit).map((s) => s.text)).toEqual(['[[Ordner/Ziel#Kopf|hier]]', '[x](Ziel.md)']);
    expect(segs.map((s) => s.text).join('')).toBe('Siehe [[Ordner/Ziel#Kopf|hier]] und [[Anderes]] sowie [x](Ziel.md).');
  });
});

describe('linkMention', () => {
  const names = ['Ziel', 'Zielnotiz'];
  it('replaces the first unlinked mention on that line, keeping other text as alias', () => {
    const text = '---\na: 1\n---\nErste Zeile\n[[Ziel]] und ziel hier, Ziel dort\r\nEnde';
    expect(linkMention(text, 4, names, 'Ziel')).toBe('---\na: 1\n---\nErste Zeile\n[[Ziel]] und [[Ziel|ziel]] hier, Ziel dort\r\nEnde');
  });
  it('writes the plain link when the text equals the link text', () => {
    expect(linkMention('a Ziel b', 0, names, 'Ziel')).toBe('a [[Ziel]] b');
    expect(linkMention('a Ziel b', 0, names, 'Ordner/Ziel')).toBe('a [[Ordner/Ziel|Ziel]] b');
  });
  it('does not use an alias that would break the link', () => {
    expect(linkMention('a Z|iel b', 0, ['Ziel', 'Z|iel'], 'Ziel')).toBe('a [[Ziel]] b');
    expect(linkMention('a Zi]]el b', 0, ['Ziel', 'Zi]]el'], 'Ziel')).toBe('a [[Ziel]] b');
  });
  it('refuses when the line no longer is the context that was shown', () => {
    expect(linkMention('  a Ziel b\n', 0, names, 'Ziel', 'a Ziel b')).toBe('  a [[Ziel]] b\n');
    expect(linkMention('a Ziel b, geändert\n', 0, names, 'Ziel', 'a Ziel b')).toBeNull();
  });
  it('returns null when the mention is gone', () => {
    expect(linkMention('nichts\nhier', 1, names, 'Ziel')).toBeNull();
    expect(linkMention('a', 5, names, 'Ziel')).toBeNull();
  });
});

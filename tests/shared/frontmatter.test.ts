import { describe, expect, it } from 'vitest';
import { updateFrontmatter } from '@shared/frontmatter';
import { parseNote } from '@shared/parse';

const DOC = [
  '---',
  '# Kopfkommentar',
  'title: "Mein Titel"',
  'status: draft',
  '',
  "author: 'Tobias'   # wer",
  'tags: [a, b]',
  'aliases:',
  '- x',
  '- y',
  '---',
  'Body',
  '',
].join('\n');

describe('updateFrontmatter', () => {
  it('set ändert nur die Zeile des Schlüssels', () => {
    const out = updateFrontmatter(DOC, [{ op: 'set', key: 'status', value: 'done' }]);
    expect(out).toBe(DOC.replace('status: draft', 'status: done'));
  });

  it('Liste bleibt im Flow-Stil', () => {
    const out = updateFrontmatter(DOC, [{ op: 'set', key: 'tags', value: ['a', 'b', 'c'] }]);
    expect(out).toBe(DOC.replace('tags: [a, b]', 'tags: [a, b, c]'));
  });

  it('Block-Liste bleibt im Block-Stil (ohne Einrückung wie im Original)', () => {
    const out = updateFrontmatter(DOC, [{ op: 'set', key: 'aliases', value: ['x', 'y', 'z'] }]);
    expect(out).toBe(DOC.replace('- y\n', '- y\n- z\n'));
  });

  it('neuer Schlüssel wird am Ende des Blocks angehängt', () => {
    const out = updateFrontmatter(DOC, [{ op: 'set', key: 'prio', value: 3 }]);
    expect(out).toBe(DOC.replace('- y\n---', '- y\nprio: 3\n---'));
  });

  it('delete entfernt nur den Schlüssel (auch mehrzeilige Werte)', () => {
    expect(updateFrontmatter(DOC, [{ op: 'delete', key: 'status' }])).toBe(DOC.replace('status: draft\n', ''));
    expect(updateFrontmatter(DOC, [{ op: 'delete', key: 'aliases' }])).toBe(DOC.replace('aliases:\n- x\n- y\n', ''));
  });

  it('delete eines fehlenden Schlüssels ändert nichts', () => {
    expect(updateFrontmatter(DOC, [{ op: 'delete', key: 'nix' }])).toBe(DOC);
  });

  it('rename ändert nur den Schlüsselnamen', () => {
    const out = updateFrontmatter(DOC, [{ op: 'rename', from: 'author', to: 'autor' }]);
    expect(out).toBe(DOC.replace("author: 'Tobias'", "autor: 'Tobias'"));
  });

  it('rename auf vorhandenen Schlüssel → Error', () => {
    expect(() => updateFrontmatter(DOC, [{ op: 'rename', from: 'author', to: 'title' }])).toThrow(Error);
  });

  it('mehrere Änderungen nacheinander', () => {
    const out = updateFrontmatter(DOC, [
      { op: 'set', key: 'status', value: 'done' },
      { op: 'delete', key: 'title' },
      { op: 'set', key: 'neu', value: 'ja' },
    ]);
    expect(parseNote(out).frontmatter).toMatchObject({ status: 'done', neu: 'ja', author: 'Tobias' });
    expect(out).not.toContain('title');
    expect(out).toContain('# Kopfkommentar');
  });

  it('Werte, die Quoting brauchen, werden korrekt serialisiert', () => {
    const out = updateFrontmatter(DOC, [{ op: 'set', key: 'status', value: 'a: b # c' }]);
    expect(parseNote(out).frontmatter?.status).toBe('a: b # c');
  });

  it('ohne Frontmatter + set → Block am Anfang', () => {
    expect(updateFrontmatter('Body\n', [{ op: 'set', key: 'k', value: 'v' }])).toBe('---\nk: v\n---\nBody\n');
  });

  it('ohne Frontmatter + set → Block nach dem BOM', () => {
    expect(updateFrontmatter('﻿Body', [{ op: 'set', key: 'k', value: 'v' }])).toBe('﻿---\nk: v\n---\nBody');
  });

  it('ohne Frontmatter + delete/rename → unverändert', () => {
    expect(updateFrontmatter('Body', [{ op: 'delete', key: 'k' }])).toBe('Body');
  });

  it('CRLF bleibt CRLF', () => {
    const crlf = DOC.replace(/\n/g, '\r\n');
    const out = updateFrontmatter(crlf, [
      { op: 'set', key: 'status', value: 'done' },
      { op: 'set', key: 'prio', value: 1 },
      { op: 'set', key: 'tags', value: ['q'] },
    ]);
    expect(out).toBe(
      crlf.replace('status: draft', 'status: done').replace('tags: [a, b]', 'tags: [q]').replace('- y\r\n---', '- y\r\nprio: 1\r\n---'),
    );
    expect(out.replace(/\r\n/g, '')).not.toContain('\n');
  });

  it('CRLF ohne Frontmatter: neuer Block mit CRLF', () => {
    expect(updateFrontmatter('A\r\nB', [{ op: 'set', key: 'k', value: 'v' }])).toBe('---\r\nk: v\r\n---\r\nA\r\nB');
  });

  it('leerer Frontmatter-Block', () => {
    expect(updateFrontmatter('---\n---\nx', [{ op: 'set', key: 'k', value: 1 }])).toBe('---\nk: 1\n---\nx');
  });

  it('leere changes → identischer String', () => {
    expect(updateFrontmatter(DOC, [])).toBe(DOC);
    expect(updateFrontmatter('Body', [])).toBe('Body');
  });

  it('ungültiges YAML → Error', () => {
    const bad = '---\na: [1, 2\nb: : :\n---\nx';
    expect(() => updateFrontmatter(bad, [{ op: 'set', key: 'k', value: 'v' }])).toThrow(Error);
  });

  it('Frontmatter, das keine Map ist → Error', () => {
    expect(() => updateFrontmatter('---\n- a\n- b\n---\nx', [{ op: 'set', key: 'k', value: 'v' }])).toThrow(Error);
  });

  it('Frontmatter-Erkennung wie parse.ts: Abschluss mit ...', () => {
    const t = '---\na: 1\n...\nBody';
    expect(updateFrontmatter(t, [{ op: 'set', key: 'a', value: 2 }])).toBe('---\na: 2\n...\nBody');
  });

  it('--- nicht in der ersten Zeile ist kein Frontmatter', () => {
    const t = 'x\n---\na: 1\n---\n';
    expect(updateFrontmatter(t, [{ op: 'set', key: 'k', value: 1 }])).toBe('---\nk: 1\n---\n' + t);
  });
});

import { describe, expect, it } from 'vitest';
import { parseNote } from '@shared/parse';
import { resolveLink, type FileLookup } from '@shared/resolve';
import { rewriteLinks } from '@shared/rewrite';

function lookup(paths: string[]): FileLookup {
  const byPath = new Map<string, string>();
  const byBasename = new Map<string, string[]>();
  for (const p of paths) {
    byPath.set(p.normalize('NFC').toLowerCase(), p);
    const b = p.slice(p.lastIndexOf('/') + 1).normalize('NFC').toLowerCase();
    byBasename.set(b, [...(byBasename.get(b) ?? []), p]);
  }
  return { byPath, byBasename };
}

/** Resolves the links of `text` in the old vault, applies `renames`, rewrites against the new vault. */
function rw(text: string, source: string, vault: string[], renames: Record<string, string>): string {
  const map = new Map(Object.entries(renames));
  const before = lookup(vault);
  const after = lookup(vault.map((p) => map.get(p) ?? p));
  const { links } = parseNote(text);
  const resolved = links.map((l) => (l.target === '' ? source : resolveLink(l.target, source, before)));
  return rewriteLinks(text, links, resolved, map, map.get(source) ?? source, after);
}

describe('rewriteLinks', () => {
  const vault = ['NXTZLT/Geteilt/A.md', 'Quelle.md', 'B.md', 'Andere/C.md'];

  it('keeps path form', () => {
    expect(rw('x [[NXTZLT/Geteilt/A|X]] y', 'Quelle.md', vault, { 'NXTZLT/Geteilt/A.md': 'NXTZLT/Archiv/A.md' })).toBe(
      'x [[NXTZLT/Archiv/A|X]] y',
    );
  });

  it('keeps .md in path-form wikilinks that had it', () => {
    expect(rw('[[NXTZLT/Geteilt/A.md]]', 'Quelle.md', vault, { 'NXTZLT/Geteilt/A.md': 'NXTZLT/Archiv/A.md' })).toBe(
      '[[NXTZLT/Archiv/A.md]]',
    );
  });

  it('keeps basename form when the new name is unique', () => {
    expect(rw('[[A]] und [[a]]', 'Quelle.md', vault, { 'NXTZLT/Geteilt/A.md': 'NXTZLT/Geteilt/Neu.md' })).toBe(
      '[[Neu]] und [[Neu]]',
    );
  });

  it('leaves basename links untouched when the file only moves folders and stays unique', () => {
    const text = 'siehe [[A]]';
    expect(rw(text, 'Quelle.md', vault, { 'NXTZLT/Geteilt/A.md': 'Archiv/A.md' })).toBe(text);
  });

  it('switches to path form when the new name is ambiguous', () => {
    expect(rw('[[A]]', 'Quelle.md', vault, { 'NXTZLT/Geteilt/A.md': 'NXTZLT/Geteilt/C.md' })).toBe('[[NXTZLT/Geteilt/C]]');
  });

  it('keeps alias, heading, block reference and embed marker', () => {
    const r = { 'NXTZLT/Geteilt/A.md': 'NXTZLT/Geteilt/Neu.md' };
    expect(rw('[[A#Kopf|Text]] [[A#^abc]] ![[A]] ![[A#Kopf]]', 'Quelle.md', vault, r)).toBe(
      '[[Neu#Kopf|Text]] [[Neu#^abc]] ![[Neu]] ![[Neu#Kopf]]',
    );
  });

  it('keeps an escaped table pipe', () => {
    const r = { 'NXTZLT/Geteilt/A.md': 'NXTZLT/Geteilt/Neu.md' };
    expect(rw('| [[A\\|Text]] |', 'Quelle.md', vault, r)).toBe('| [[Neu\\|Text]] |');
  });

  it('URL-encodes markdown links and keeps .md and subpath', () => {
    const r = { 'B.md': 'Mein Text.md' };
    expect(rw('[t](B.md#Kopf)', 'Quelle.md', vault, r)).toBe('[t](Mein%20Text.md#Kopf)');
  });

  it('encodes special characters so the link parses back to the new path', () => {
    const name = 'Ordner (alt)/C# – 100%? [x].md';
    const out = rw('[t](Dir/B.md)', 'Quelle.md', ['Quelle.md', 'Dir/B.md'], { 'Dir/B.md': name });
    expect(out).toBe('[t](Ordner%20%28alt%29/C%23%20%E2%80%93%20100%25%3F%20%5Bx%5D.md)');
    expect(parseNote(out).links[0]?.target).toBe(name);
  });

  it('keeps markdown links relative when they were relative', () => {
    const v = ['Ordner/Quelle.md', 'Ordner/Sub/X.md', 'Y.md'];
    expect(rw('[x](Sub/X.md) [y](../Y.md)', 'Ordner/Quelle.md', v, { 'Ordner/Sub/X.md': 'Ordner/Neu/X Neu.md', 'Y.md': 'Z/Y.md' })).toBe(
      '[x](Neu/X%20Neu.md) [y](../Z/Y.md)',
    );
  });

  it('uses vault paths for markdown links that were vault-absolute', () => {
    const v = ['Ordner/Quelle.md', 'Andere/X.md', 'Andere/Y.md', 'Dritte/Y.md'];
    expect(rw('[x](Andere/X.md)', 'Ordner/Quelle.md', v, { 'Andere/X.md': 'Archiv/X 2.md' })).toBe('[x](Archiv/X%202.md)');
  });

  it('keeps angle-bracket markdown links readable', () => {
    expect(rw('[t](<B.md>)', 'Quelle.md', vault, { 'B.md': 'Mein Text.md' })).toBe('[t](<Mein Text.md>)');
  });

  it('rewrites markdown embeds of attachments', () => {
    const v = ['Quelle.md', 'Anhänge/bild.png'];
    expect(rw('![alt](Anhänge/bild.png) ![[bild.png]]', 'Quelle.md', v, { 'Anhänge/bild.png': 'Anhänge/Foto 1.png' })).toBe(
      '![alt](Anh%C3%A4nge/Foto%201.png) ![[Foto 1.png]]',
    );
  });

  it('leaves links to other targets, unresolved links and same-note links unchanged', () => {
    const text = '[[B]] [[Fehlt]] [[#Kopf]] [t](Andere/C.md) [[A]]';
    expect(rw(text, 'Quelle.md', vault, { 'NXTZLT/Geteilt/A.md': 'NXTZLT/Geteilt/Neu.md' })).toBe(
      '[[B]] [[Fehlt]] [[#Kopf]] [t](Andere/C.md) [[Neu]]',
    );
  });

  it('changes only the bytes of affected link ranges (CRLF, BOM, frontmatter, NFD text kept)', () => {
    const nfd = 'Übersicht'.normalize('NFD');
    const text = `﻿---\r\ntitle: x\r\n---\r\n${nfd} [[A]]  \r\n\r\n- [ ] [[B]]\r\n`;
    const out = rw(text, 'Quelle.md', vault, { 'NXTZLT/Geteilt/A.md': 'NXTZLT/Geteilt/Neu.md' });
    expect(out).toBe(text.replace('[[A]]', '[[Neu]]'));
  });

  // `[z](Z.md)` still resolves (unique file name) and therefore stays as it is.
  it('fixes relative links of a moved source note', () => {
    const v = ['Ordner/Quelle.md', 'Y.md', 'Ordner/Z.md'];
    const r = { 'Ordner/Quelle.md': 'Neu/Tief/Quelle.md' };
    expect(rw('[y](../Y.md) [z](Z.md) [[Z]]', 'Ordner/Quelle.md', v, r)).toBe('[y](../../Y.md) [z](Z.md) [[Z]]');
  });

  it('renames self links', () => {
    expect(rw('[[Quelle#Kopf]]', 'Quelle.md', vault, { 'Quelle.md': 'Ziel.md' })).toBe('[[Ziel#Kopf]]');
  });
});

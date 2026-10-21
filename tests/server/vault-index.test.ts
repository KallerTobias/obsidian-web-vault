import { describe, expect, it } from 'vitest';
import { VaultIndex } from '../../server/index/vault-index';

describe('VaultIndex', () => {
  it('computes backlinks with context lines', () => {
    const ix = new VaultIndex();
    ix.upsert('A.md', 'x\nSiehe [[B]] hier\n');
    ix.upsert('B.md', 'b');
    expect(ix.backlinks('B.md')).toEqual([{ source: 'A.md', contexts: [{ line: 1, text: 'Siehe [[B]] hier' }] }]);
    expect(ix.note('A.md')?.resolved).toEqual(['B.md']);
  });
  it('ignores same-note links and self backlinks', () => {
    const ix = new VaultIndex();
    ix.upsert('A.md', '# Kopf\n[[#Kopf]] [[A]]');
    expect(ix.backlinks('A.md')).toEqual([]);
    expect(ix.graph().links).toEqual([]);
    expect(ix.unresolved().size).toBe(0);
  });
  it('rename via remove+upsert updates backlinks of other notes', () => {
    const ix = new VaultIndex();
    ix.upsert('A.md', '[[B]]');
    ix.upsert('B.md', '');
    ix.remove('B.md');
    expect(ix.backlinks('B.md')).toEqual([]);
    expect(ix.unresolved().get('B')).toEqual(['A.md']);
    ix.upsert('Neu/B.md', '');
    expect(ix.backlinks('Neu/B.md').map((b) => b.source)).toEqual(['A.md']);
    expect(ix.unresolved().size).toBe(0);
  });
  it('a new file resolves previously unresolved links (notes and attachments)', () => {
    const ix = new VaultIndex();
    ix.upsert('A.md', '[[Spaeter]] ![[bild.png]]');
    expect([...ix.unresolved().keys()].sort()).toEqual(['Spaeter', 'bild.png']);
    ix.upsert('Spaeter.md', '');
    ix.addFile('Anhang/bild.png');
    expect(ix.unresolved().size).toBe(0);
    expect(ix.note('A.md')?.resolved).toEqual(['Spaeter.md', 'Anhang/bild.png']);
  });
  it('prefers a closer duplicate when it appears and falls back when removed', () => {
    const ix = new VaultIndex();
    ix.upsert('X/Q.md', '');
    ix.upsert('Y/src.md', '[[Q]]');
    expect(ix.note('Y/src.md')?.resolved).toEqual(['X/Q.md']);
    ix.upsert('Y/Q.md', '');
    expect(ix.note('Y/src.md')?.resolved).toEqual(['Y/Q.md']);
    ix.remove('Y/Q.md');
    expect(ix.note('Y/src.md')?.resolved).toEqual(['X/Q.md']);
  });
  it('resolves markdown links relative to the note, and NFD names', () => {
    const ix = new VaultIndex();
    ix.upsert('Ordner/n.md', '[a](Sub/c.md) [b](bild.png) [[Übersicht]]');
    ix.upsert('Ordner/Sub/c.md', '');
    ix.addFile('Ordner/bild.png');
    ix.upsert('Übersicht.md'.normalize('NFD'), '');
    expect(ix.note('Ordner/n.md')?.resolved).toEqual(['Ordner/Sub/c.md', 'Ordner/bild.png', 'Übersicht.md'.normalize('NFD')]);
  });
  it('unlinkedMentions finds titles and aliases as whole words, not in self or linked notes', () => {
    const ix = new VaultIndex();
    ix.upsert('Projekt Alpha.md', '---\naliases: [PA]\n---\nProjekt Alpha ist hier');
    ix.upsert('N1.md', 'Zeile\nWir reden über projekt alpha heute');
    ix.upsert('N2.md', 'Das PA ist gut, aber PAUSE nicht');
    ix.upsert('N3.md', 'Projekt Alpha und [[Projekt Alpha]]');
    ix.upsert('N4.md', 'Projekt Alphabet');
    const m = ix.unlinkedMentions('Projekt Alpha.md');
    expect(m.map((b) => b.source).sort()).toEqual(['N1.md', 'N2.md']);
    expect(m.find((b) => b.source === 'N1.md')?.contexts).toEqual([{ line: 1, text: 'Wir reden über projekt alpha heute' }]);
  });
  it('tags count body and frontmatter tags, nested tags count for parents', () => {
    const ix = new VaultIndex();
    ix.upsert('A.md', '---\ntags: [x]\n---\n#a/b #x');
    ix.upsert('B.md', '#a');
    const t = ix.tags();
    expect(t.get('a')).toBe(2);
    expect(t.get('a/b')).toBe(1);
    expect(t.get('x')).toBe(2);
    ix.remove('B.md');
    expect(ix.tags().get('a')).toBe(1);
    ix.upsert('A.md', 'nichts');
    expect(ix.tags().size).toBe(0);
  });
  it('graph has note, attachment, tag and unresolved nodes with degree', () => {
    const ix = new VaultIndex();
    ix.upsert('Ordner/A.md', '#t [[B]] ![[bild.png]] [[Fehlt]] [[B]]');
    ix.upsert('B.md', '');
    ix.addFile('bild.png');
    ix.addFile('lose.png');
    const g = ix.graph();
    const byId = new Map(g.nodes.map((n) => [n.id, n]));
    expect(byId.get('Ordner/A.md')).toMatchObject({ kind: 'note', name: 'A', folder: 'Ordner', tags: ['t'], degree: 4 });
    expect(byId.get('B.md')).toMatchObject({ kind: 'note', degree: 1 });
    expect(byId.get('bild.png')).toMatchObject({ kind: 'attachment', degree: 1 });
    expect(byId.get('tag:#t')).toMatchObject({ kind: 'tag', degree: 1 });
    expect(byId.get('unresolved:Fehlt')).toMatchObject({ kind: 'unresolved', degree: 1 });
    expect(byId.has('lose.png')).toBe(false);
    expect(g.links).toHaveLength(4);
  });
});

describe('VaultIndex duplicate links', () => {
  it('keeps reverse map consistent when a note links the same target twice', () => {
    const ix = new VaultIndex();
    ix.upsert('B.md', '');
    ix.upsert('A.md', '[[B]] [[B]]');
    ix.upsert('A.md', '[[B]] [[B]] [[B]]');
    expect(ix.backlinks('B.md')).toHaveLength(1);
    ix.upsert('A.md', 'weg');
    expect(ix.backlinks('B.md')).toEqual([]);
    ix.upsert('A.md', '[[B]] [[B]]');
    ix.upsert('B2/B.md', '');
    ix.remove('B.md');
    expect(ix.backlinks('B2/B.md')).toHaveLength(1);
    expect(ix.backlinks('B.md')).toEqual([]);
  });
});

/// <reference lib="dom" />
import { describe, expect, it, vi } from 'vitest';
import { createFileLookup } from '@shared/resolve';
import { extractSection, hydrateEmbeds, MAX_EMBED_DEPTH, MAX_EMBEDS } from '../../web/src/lib/markdown/embeds';
import { renderMarkdown } from '../../web/src/lib/markdown/render';

describe('extractSection', () => {
  const note = ['# Titel', 'Intro', '## Teil A', 'a1', '### Unter', 'u1', '## Teil B', 'b1', '# Zweiter', 'z'].join('\n');

  it('returns the whole text without subpath', () => {
    expect(extractSection(note, undefined)).toBe(note);
  });

  it('cuts a heading section up to the next heading of the same or higher level', () => {
    expect(extractSection(note, 'Teil A')).toBe('## Teil A\na1\n### Unter\nu1');
    expect(extractSection(note, 'teil b')).toBe('## Teil B\nb1');
    expect(extractSection(note, 'Titel#Teil A#Unter')).toBe('### Unter\nu1');
    expect(extractSection(note, 'Zweiter')).toBe('# Zweiter\nz');
  });

  it('returns null for a missing heading or block', () => {
    expect(extractSection(note, 'Gibt es nicht')).toBeNull();
    expect(extractSection(note, '^fehlt')).toBeNull();
    expect(extractSection(note, '^a.b')).toBeNull();
  });

  it('cuts a block by its ID: paragraph, list item, or the block before a standalone ID', () => {
    const text = ['Erste Zeile', 'zweite Zeile ^abs', '', '- eins', '- zwei ^li', '- drei', '', '| a |', '|---|', '| b |', '', '^tab'].join('\n');
    expect(extractSection(text, '^abs')).toBe('Erste Zeile\nzweite Zeile');
    expect(extractSection(text, '^li')).toBe('- zwei');
    expect(extractSection(text, '^tab')).toBe('| a |\n|---|\n| b |');
  });
});

describe('hydrateEmbeds', () => {
  const lookup = createFileLookup(['A.md', 'B.md', 'C.md', 'D.md', 'E.md', 'Doc.pdf', 'Ton.mp3', 'Film.mp4', 'Daten.zip']);

  function root(md: string, path = 'A.md'): HTMLElement {
    const el = document.createElement('div');
    el.innerHTML = renderMarkdown(md, { path, lookup });
    return el;
  }

  it('renders an embedded note one level deeper, with a link to it', async () => {
    const load = vi.fn(async () => '# Kopf\n\n- [ ] Aufgabe\n\nText von B');
    const el = root('![[B]]');
    await hydrateEmbeds(el, { lookup, depth: 0, chain: ['A.md'], load });
    expect(load).toHaveBeenCalledWith('B.md');
    const embed = el.querySelector<HTMLElement>('.embed')!;
    expect(embed.dataset.embedState).toBe('done');
    expect(embed.querySelector('.embed-content')!.textContent).toContain('Text von B');
    expect(embed.querySelector<HTMLElement>('a.embed-link')!.dataset.href).toBe('B.md');
    // Tasks in embeds are not clickable (they belong to another note).
    expect(embed.querySelector<HTMLInputElement>('input')!.disabled).toBe(true);
  });

  it('embeds only the requested section', async () => {
    const el = root('![[B#Zwei]]');
    await hydrateEmbeds(el, { lookup, depth: 0, chain: ['A.md'], load: async () => '## Eins\neins\n## Zwei\nzwei' });
    const content = el.querySelector('.embed-content')!;
    expect(content.textContent).toContain('zwei');
    expect(content.textContent).not.toContain('eins');
  });

  it('shows a notice for a missing section and for load errors', async () => {
    const el = root('![[B#Fehlt]]\n\n![[C]]');
    await hydrateEmbeds(el, {
      lookup,
      depth: 0,
      chain: ['A.md'],
      load: async (p) => {
        if (p === 'C.md') throw new Error('404');
        return 'x';
      },
    });
    expect([...el.querySelectorAll<HTMLElement>('.embed')].map((e) => e.dataset.embedState)).toEqual(['missing', 'failed']);
    expect(el.querySelector('.embed-notice')!.textContent).toContain('Fehlt');
  });

  it('detects cycles (A embeds B embeds A) and self-embeds', async () => {
    const notes: Record<string, string> = { 'A.md': '![[B]]', 'B.md': 'B-Text\n\n![[A]]' };
    const el = root('![[B]]\n\n![[A]]');
    await hydrateEmbeds(el, { lookup, depth: 0, chain: ['A.md'], load: async (p) => notes[p]! });
    const states = [...el.querySelectorAll<HTMLElement>('.embed')].map((e) => e.dataset.embedState);
    // Outer B: done; A inside B: cycle; the self-embed of A: cycle.
    expect(states).toEqual(['done', 'cycle', 'cycle']);
    expect(el.textContent).toContain('B-Text');
  });

  it('allows the same note twice with different sections', async () => {
    const el = root('![[B#Eins]]\n\n![[B#Zwei]]', 'A.md');
    await hydrateEmbeds(el, { lookup, depth: 0, chain: ['A.md'], load: async () => '## Eins\n1\n## Zwei\n2' });
    expect([...el.querySelectorAll<HTMLElement>('.embed')].map((e) => e.dataset.embedState)).toEqual(['done', 'done']);
  });

  it(`stops nesting after ${MAX_EMBED_DEPTH} levels`, async () => {
    const notes: Record<string, string> = { 'B.md': 'b ![[C]]', 'C.md': 'c\n\n![[D]]', 'D.md': 'd\n\n![[E]]', 'E.md': 'e' };
    const el = root('![[B]]');
    await hydrateEmbeds(el, { lookup, depth: 0, chain: ['A.md'], load: async (p) => notes[p]! });
    expect(el.textContent).toContain('d');
    expect(el.textContent).not.toMatch(/(^|\s)e(\s|$)/);
    expect(el.querySelector<HTMLElement>('[data-embed="E.md"]')!.dataset.embedState).toBe('too-deep');
  });

  it(`fills at most ${MAX_EMBEDS} embeds per view, the rest get a notice`, async () => {
    const el = root(Array.from({ length: MAX_EMBEDS + 5 }, () => '![[Ton.mp3]]').join('\n\n'));
    await hydrateEmbeds(el, { lookup, depth: 0, chain: ['A.md'], load: vi.fn() });
    const states = [...el.querySelectorAll<HTMLElement>('.embed')].map((e) => e.dataset.embedState);
    expect(states.filter((s) => s === 'done')).toHaveLength(MAX_EMBEDS);
    expect(states.filter((s) => s === 'over-budget')).toHaveLength(5);
  });

  it('shares the embed budget across nesting levels', async () => {
    const notes: Record<string, string> = { 'B.md': 'b\n\n![[C]]', 'C.md': 'c\n\n![[D]]', 'D.md': 'd' };
    const el = root('![[B]]');
    await hydrateEmbeds(el, { lookup, depth: 0, chain: ['A.md'], load: async (p) => notes[p]!, budget: { left: 2 } });
    expect(el.querySelector<HTMLElement>('[data-embed="D.md"]')!.dataset.embedState).toBe('over-budget');
  });

  it('fills PDF, audio, video and download embeds', async () => {
    const el = root('![[Doc.pdf#page=3]]\n\n![[Ton.mp3]]\n\n![[Film.mp4]]\n\n![[Daten.zip]]');
    const load = vi.fn();
    await hydrateEmbeds(el, { lookup, depth: 0, chain: ['A.md'], load });
    expect(load).not.toHaveBeenCalled();
    expect(el.querySelector('iframe')!.getAttribute('src')).toBe('/api/file?path=Doc.pdf#page=3');
    expect(el.querySelector('audio')!.getAttribute('src')).toBe('/api/file?path=Ton.mp3');
    expect(el.querySelector('video')!.controls).toBe(true);
    expect(el.querySelector('a[download]')!.getAttribute('href')).toBe('/api/file?path=Daten.zip');
  });
});

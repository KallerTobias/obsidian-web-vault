/// <reference lib="dom" />
/// <reference types="svelte" />
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { tick } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFileLookup } from '@shared/resolve';
import ReadingView from '../../../web/src/components/ReadingView.svelte';
import { subpathId } from '../../../web/src/lib/markdown/render';

const lookup = createFileLookup(['Start.md', 'Notiz.md']);

afterEach(cleanup);

function show(content: string, extra: Record<string, unknown> = {}) {
  const props = { path: 'Start.md', content, lookup, loadNote: async () => 'eingebettet', ...extra };
  return render(ReadingView, { props });
}

describe('ReadingView', () => {
  it('opens internal links, with Ctrl/Cmd in a new tab, and reports unresolved ones', async () => {
    const onOpenLink = vi.fn();
    const { container } = show('[[Notiz#Kopf]] [[Neu]]', { onOpenLink });
    const [a, b] = container.querySelectorAll('a.internal-link');
    await fireEvent.click(a!);
    await fireEvent.click(b!, { ctrlKey: true });
    expect(onOpenLink.mock.calls).toEqual([
      ['Notiz.md', { subpath: 'Kopf', newTab: false, unresolved: false }],
      ['Neu', { subpath: undefined, newTab: true, unresolved: true }],
    ]);
  });

  it('reports tag clicks', async () => {
    const onTag = vi.fn();
    const { container } = show('Ein #a/b', { onTag });
    await fireEvent.click(container.querySelector('a.tag')!);
    expect(onTag).toHaveBeenCalledWith('a/b');
  });

  it('reports task clicks with the source line and leaves the box to the saved text', async () => {
    const onToggleTask = vi.fn();
    const { container } = show('Text\n\n- [ ] eins\n- [x] zwei', { onToggleTask });
    const boxes = container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
    await fireEvent.click(boxes[1]!);
    expect(onToggleTask).toHaveBeenCalledWith(3);
    expect(boxes[1]!.checked).toBe(true);
  });

  it('starts folded callouts collapsed and toggles them by their title', async () => {
    const { container } = show('> [!faq]- Frage\n> Antwort\n\n> [!tip]+ Offen\n> x');
    const [folded, open] = container.querySelectorAll<HTMLElement>('.callout');
    expect(folded!.classList.contains('is-collapsed')).toBe(true);
    expect(open!.classList.contains('is-collapsed')).toBe(false);
    const title = folded!.querySelector<HTMLElement>('.callout-title')!;
    expect(title.getAttribute('aria-expanded')).toBe('false');
    await fireEvent.click(title);
    expect(folded!.classList.contains('is-collapsed')).toBe(false);
    expect(title.getAttribute('aria-expanded')).toBe('true');
    await fireEvent.keyDown(title, { key: 'Enter' });
    expect(folded!.classList.contains('is-collapsed')).toBe(true);
  });

  it('fills note embeds', async () => {
    const { container, findByText } = show('![[Notiz]]');
    expect(await findByText('eingebettet')).toBeTruthy();
    expect(container.querySelector<HTMLElement>('.embed')!.dataset.embedState).toBe('done');
  });

  it('re-renders when the content changes', async () => {
    const { container, rerender } = show('# Alt');
    await rerender({ content: '# Neu' });
    expect(container.querySelector('h1')!.textContent).toBe('Neu');
  });
});

describe('ReadingView – navigation and guards', () => {
  let scrolled: string[];
  beforeEach(() => {
    scrolled = [];
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled.push(this.id);
    };
  });
  afterEach(() => {
    delete (Element.prototype as Partial<Element>).scrollIntoView;
  });

  it('scrolls to the subpath on navigation only, not on every re-render', async () => {
    const { rerender } = show('# Eins\n\n## Zwei', { subpath: 'Zwei' });
    await tick();
    expect(scrolled).toEqual(['user-content-zwei']);
    await rerender({ content: '# Eins\n\n## Zwei\n\nmehr Text' });
    await rerender({ lookup: createFileLookup(['Start.md', 'Notiz.md', 'Neu.md']) });
    await tick();
    expect(scrolled).toEqual(['user-content-zwei']);
    await rerender({ subpath: 'Eins' });
    await tick();
    expect(scrolled).toEqual(['user-content-zwei', 'user-content-eins']);
  });

  it('scrolls once more after the embeds above the target have loaded', async () => {
    let release!: (t: string) => void;
    const loadNote = () => new Promise<string>((r) => (release = r));
    show('![[Notiz]]\n\n## Ziel', { subpath: 'Ziel', loadNote });
    await tick();
    expect(scrolled).toEqual(['user-content-ziel']);
    release('Langer eingebetteter Text');
    await vi.waitFor(() => expect(scrolled).toEqual(['user-content-ziel', 'user-content-ziel']));
  });

  it('ignores checkboxes inside embeds and internal links without a target', async () => {
    const onToggleTask = vi.fn();
    const onOpenLink = vi.fn();
    const { container } = show('Text', { onToggleTask, onOpenLink });
    const root = container.querySelector('.reading-view')!;
    const embed = document.createElement('div');
    embed.className = 'embed-content';
    embed.innerHTML = '<input type="checkbox" data-line="0"><a class="internal-link" href="#">x</a>';
    root.append(embed);
    await fireEvent.click(embed.querySelector('input')!);
    await fireEvent.click(embed.querySelector('a')!);
    expect(onToggleTask).not.toHaveBeenCalled();
    expect(onOpenLink).not.toHaveBeenCalled();
  });
});

describe('subpathId', () => {
  it('matches the ids of rendered headings and blocks', () => {
    expect(subpathId('Überschrift Eins')).toBe('user-content-überschrift-eins');
    expect(subpathId('^abc-1')).toBe('user-content-^abc-1');
    expect(subpathId('A#B c')).toBe('user-content-b-c');
  });

  it('exposes scrollToSubpath() for heading and block targets', async () => {
    const { component, container } = show('# Eins\n\nAbsatz ^blk\n\n## Zwei');
    const scrolled: string[] = [];
    for (const el of container.querySelectorAll<HTMLElement>('[id]')) el.scrollIntoView = () => scrolled.push(el.id);
    const view = component as unknown as { scrollToSubpath(s: string): boolean };
    expect(view.scrollToSubpath('Zwei')).toBe(true);
    expect(view.scrollToSubpath('^blk')).toBe(true);
    expect(view.scrollToSubpath('Fehlt')).toBe(false);
    expect(scrolled).toEqual(['user-content-zwei', 'user-content-^blk']);
  });
});

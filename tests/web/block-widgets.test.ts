/// <reference lib="dom" />
import { cursorLineUp, deleteCharBackward, deleteLine, moveLineUp, selectAll } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { ensureSyntaxTree, syntaxTreeAvailable } from '@codemirror/language';
import { EditorSelection, EditorState, type SelectionRange } from '@codemirror/state';
import { EditorView, type WidgetType } from '@codemirror/view';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFileLookup } from '@shared/resolve';

vi.mock('../../web/src/lib/markdown/mermaid', () => ({ renderMermaid: vi.fn(async () => {}) }));

import { blockPreviewField, blockWidgetStats, computeBlockWidgets, embedBudgetLeft, setBlockRange } from '../../web/src/lib/editor/block-widgets';
import { livePreviewContext, refreshLinks, type LivePreviewContext } from '../../web/src/lib/editor/inline-hide';
import { livePreview } from '../../web/src/lib/editor/live-preview';
import { obsidianMarkdown } from '../../web/src/lib/editor/syntax';
import { renderMermaid } from '../../web/src/lib/markdown/mermaid';
import { MAX_EMBEDS } from '../../web/src/lib/markdown/embeds';

const files = createFileLookup(['Start.md', 'A.md', 'Notiz.md', 'bild.jpg', 'Bilder/foto.png', 'doc.pdf']);
const ctx: LivePreviewContext = {
  // The app hands out the same lookup until the vault changes.
  lookup: () => files,
  path: 'Start.md',
  openLink: () => {},
};

const lang = markdown({ base: markdownLanguage, extensions: obsidianMarkdown });

function parsed(state: EditorState): EditorState {
  ensureSyntaxTree(state, state.doc.length, 5000);
  return state.update({}).state;
}

/** `doc` followed by a separate paragraph `ende`; the cursor sits at its end unless `selection` is given. */
function stateOf(doc: string, selection?: EditorSelection | SelectionRange): EditorState {
  const full = doc + '\n\nende';
  return parsed(
    EditorState.create({
      doc: full,
      selection: selection ?? EditorSelection.cursor(full.length),
      extensions: [lang, livePreviewContext.of(ctx), EditorState.allowMultipleSelections.of(true)],
    }),
  );
}

const kinds = (s: EditorState) => computeBlockWidgets(s).map((w) => ({ kind: w.kind, text: s.sliceDoc(w.from, w.to) }));

describe('computeBlockWidgets', () => {
  it('always hides the frontmatter, including its line break', () => {
    const s = stateOf('---\ntitel: x\ntags: [a]\n---\nText');
    expect(kinds(s)).toContainEqual({ kind: 'frontmatter', text: '---\ntitel: x\ntags: [a]\n---\n' });
    // Also with the cursor inside it (live mode keeps the cursor out, see below).
    const inside = stateOf('---\ntitel: x\n---\nText', EditorSelection.cursor(5));
    expect(kinds(inside)[0]).toEqual({ kind: 'frontmatter', text: '---\ntitel: x\n---\n' });
  });

  it('frontmatter after a BOM and in CRLF documents', () => {
    const s = parsed(EditorState.create({ doc: '﻿---\r\na: 1\r\n---\r\nText', extensions: [lang, EditorState.lineSeparator.of('\r\n')] }));
    const fm = computeBlockWidgets(s).find((w) => w.kind === 'frontmatter')!;
    expect(fm.from).toBe(0);
    expect(s.doc.sliceString(fm.to)).toBe('Text');
  });

  it('no frontmatter without the closing line; nothing inside the frontmatter becomes a widget', () => {
    expect(kinds(stateOf('---\nText')).map((k) => k.kind)).toEqual(['hr']);
    expect(kinds(stateOf('---\na: ![[bild.jpg]]\n---\n')).map((k) => k.kind)).toEqual(['frontmatter']);
  });

  it('task items get a checkbox widget over `- [ ]` unless the cursor is on the line', () => {
    const s = stateOf('- [ ] offen\n- [x] fertig\n1. [ ] nummeriert');
    expect(computeBlockWidgets(s).map((w) => ({ kind: w.kind, text: s.sliceDoc(w.from, w.to), checked: w.checked }))).toEqual([
      { kind: 'checkbox', text: '- [ ]', checked: false },
      { kind: 'checkbox', text: '- [x]', checked: true },
      // Ordered items keep their number.
      { kind: 'checkbox', text: '[ ]', checked: false },
    ]);
    expect(kinds(stateOf('- [ ] offen\n- [x] fertig', EditorSelection.cursor(3)))).toEqual([{ kind: 'checkbox', text: '- [x]' }]);
  });

  it('`![[bild.jpg|300]]` becomes an image widget (with its size) unless the cursor is on the line', () => {
    const s = stateOf('Bild: ![[bild.jpg|300]] und ![[foto.png|300x200]]');
    const imgs = computeBlockWidgets(s);
    expect(imgs.map((w) => [w.kind, s.sliceDoc(w.from, w.to), w.target, w.width, w.height])).toEqual([
      ['image', '![[bild.jpg|300]]', 'bild.jpg', 300, undefined],
      ['image', '![[foto.png|300x200]]', 'Bilder/foto.png', 300, 200],
    ]);
    expect(computeBlockWidgets(stateOf('![[bild.jpg|300]]', EditorSelection.cursor(4)))).toEqual([]);
  });

  it('Markdown images: vault files resolve, unresolved ones are null (placeholder), external ones stay text', () => {
    const s = stateOf('![Foto|250](Bilder/foto.png)\n\n![x](fehlt.png)\n\n![ext](https://example.com/a.png)');
    expect(computeBlockWidgets(s).map((w) => [w.kind, w.target, w.width, w.alt])).toEqual([
      ['image', 'Bilder/foto.png', 250, 'Foto'],
      ['image', null, undefined, 'x'],
    ]);
    expect(computeBlockWidgets(stateOf('![[weg.jpg]]'))).toMatchObject([{ kind: 'image', target: null }]);
    // External wikilink images stay text too.
    expect(computeBlockWidgets(stateOf('![[https://example.com/x.png]]'))).toEqual([]);
  });

  it('`![[Notiz]]` becomes an embed widget; alone on a line it is a block', () => {
    const s = stateOf('![[Notiz]]\n\nText ![[Notiz#Kopf]] und ![[doc.pdf]]');
    expect(computeBlockWidgets(s).map((w) => [w.kind, s.sliceDoc(w.from, w.to), w.block ?? false])).toEqual([
      ['embed', '![[Notiz]]', true],
      ['embed', '![[Notiz#Kopf]]', false],
      ['embed', '![[doc.pdf]]', false],
    ]);
  });

  const blocks = [
    ['callout', '> [!note] Titel\n> Inhalt **fett**'],
    ['table', '| a | b |\n|---|---|\n| 1 | 2 |'],
    ['math', '$$\nx^2\n$$'],
    ['math', '$$x^2$$'],
    ['mermaid', '```mermaid\ngraph TD\nA-->B\n```'],
  ] as const;

  for (const [kind, src] of blocks) {
    it(`${kind}: one widget over the whole block while the cursor is outside, source when inside`, () => {
      const doc = `vorher\n\n${src}\n\nnachher`;
      expect(kinds(stateOf(doc))).toEqual([{ kind, text: src }]);
      // Cursor on the last line of the block, then on the line right after it.
      const last = doc.indexOf('\n\nnachher');
      expect(kinds(stateOf(doc, EditorSelection.cursor(last))).filter((k) => k.kind === kind)).toEqual([]);
      expect(kinds(stateOf(doc, EditorSelection.cursor(last + 1)))).toEqual([{ kind, text: src }]);
      // A selection that starts before the block and ends inside it.
      expect(kinds(stateOf(doc, EditorSelection.range(0, doc.indexOf(src) + 1))).filter((k) => k.kind === kind)).toEqual([]);
    });
  }

  it('a plain block quote stays text', () => {
    expect(kinds(stateOf('> nur Zitat'))).toEqual([]);
  });

  it('code blocks stay text (kind `code`: no widget), also with the cursor elsewhere', () => {
    const src = '```js\nconst a = 1;\n```';
    expect(kinds(stateOf(src))).toEqual([{ kind: 'code', text: src }]);
    // A mermaid fence being edited is shown as code.
    const m = '```mermaid\ngraph\n```';
    expect(kinds(stateOf(m, EditorSelection.cursor(3)))).toEqual([{ kind: 'code', text: m }]);
  });

  it('`---` becomes a line (but not a setext heading underline)', () => {
    expect(kinds(stateOf('a\n\n---\n\nb'))).toEqual([{ kind: 'hr', text: '---' }]);
    expect(kinds(stateOf('Titel\n---'))).toEqual([]);
    expect(kinds(stateOf('a\n\n---\n\nb', EditorSelection.cursor(4)))).toEqual([]);
  });

  it('nested blocks (in lists or quotes) stay text, tasks inside a callout are hidden with it', () => {
    expect(kinds(stateOf('- | a |\n  |---|\n  | 1 |')).map((k) => k.kind)).not.toContain('table');
    expect(kinds(stateOf('> [!todo] T\n> - [ ] x')).map((k) => k.kind)).toEqual(['callout']);
  });

  it('only blocks within the given ranges', () => {
    const doc = Array.from({ length: 50 }, (_, i) => `- [ ] ${i}`).join('\n');
    const s = stateOf(doc);
    const line10 = s.doc.line(10);
    const line20 = s.doc.line(20);
    const ws = computeBlockWidgets(s, [{ from: line10.from, to: line20.to }]);
    expect(ws).toHaveLength(11);
    expect(ws[0]!.from).toBe(line10.from);
  });
});

describe('block preview in the editor', () => {
  let view: EditorView | undefined;
  const openLink = vi.fn();
  const loadNote = vi.fn(async (_p: string) => 'Hallo **Welt**');

  function make(doc: string, cursor = doc.length, extra: Partial<LivePreviewContext> = {}): EditorView {
    view = new EditorView({
      parent: document.body,
      state: EditorState.create({
        doc,
        selection: EditorSelection.cursor(cursor),
        extensions: [lang, livePreview({ ...ctx, openLink, loadNote, ...extra })],
      }),
    });
    // Parse it all (the view parses lazily); the field picks the tree up on the next transaction.
    for (let i = 0; i < 20 && !syntaxTreeAvailable(view.state, doc.length); i++) {
      ensureSyntaxTree(view.state, doc.length, 5000);
      view.dispatch({});
    }
    expect(syntaxTreeAvailable(view.state, doc.length)).toBe(true);
    return view;
  }

  beforeEach(() => {
    openLink.mockClear();
    loadNote.mockClear();
  });
  afterEach(() => {
    view?.destroy();
    view = undefined;
  });

  const down = (el: Element, init: MouseEventInit = {}) => el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, ...init }));

  it('hides the frontmatter in live mode; the source mode shows it', () => {
    const doc = '---\ntitel: geheim\n---\nText';
    const v = make(doc);
    expect(v.contentDOM.textContent).not.toContain('geheim');
    expect(v.contentDOM.textContent).toContain('Text');
    const src = new EditorView({ parent: document.body, state: EditorState.create({ doc, extensions: [lang] }) });
    expect(src.contentDOM.textContent).toContain('geheim');
    src.destroy();
  });

  it('keeps the cursor out of the hidden frontmatter (arrow up, Ctrl+Home, select all)', () => {
    const doc = '---\na: 1\n---\nerste\nzweite';
    const body = doc.indexOf('erste');
    const v = make(doc, doc.length);
    v.dispatch({ selection: EditorSelection.cursor(0) });
    expect(v.state.selection.main.head).toBe(body);
    v.dispatch({ selection: EditorSelection.cursor(body + 2) });
    cursorLineUp(v);
    expect(v.state.selection.main.head).toBe(body);
    selectAll(v);
    expect(v.state.selection.main.from).toBe(body);
    // Backspace at the start of the body does not touch the frontmatter.
    v.dispatch({ selection: EditorSelection.cursor(body) });
    deleteCharBackward(v);
    expect(v.state.doc.toString()).toBe(doc);
    // Typing at the start of the body works.
    v.dispatch({ changes: { from: body, insert: 'X' }, selection: EditorSelection.cursor(body + 1), userEvent: 'input.type' });
    expect(v.state.doc.toString()).toBe('---\na: 1\n---\nXerste\nzweite');
  });

  it('moves an initial cursor out of the frontmatter; select all + delete keeps it; reloads may change it', async () => {
    const doc = '---\na: 1\n---\nText';
    const v = make(doc, 0);
    await Promise.resolve();
    expect(v.state.selection.main.head).toBe(doc.indexOf('Text'));
    selectAll(v);
    v.dispatch(v.state.replaceSelection(''), { userEvent: 'delete.selection' });
    expect(v.state.doc.toString()).toBe('---\na: 1\n---\n');
    // Not typed (reload from disk, properties panel): applied.
    v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: '---\nb: 2\n---\nNeu' } });
    expect(v.state.doc.toString()).toBe('---\nb: 2\n---\nNeu');
  });

  it('line commands on the first body line do not half-change the frontmatter', () => {
    const doc = '---\na: 1\n---\nBody\nzwei';
    const body = doc.indexOf('Body');
    const v = make(doc, body + 2);
    moveLineUp(v);
    expect(v.state.doc.toString()).toBe(doc);
    // The only body line: deleting it would take the frontmatter's line break.
    const one = make('---\na: 1\n---\nBody', 15);
    deleteLine(one);
    expect(one.state.doc.toString()).toBe('---\na: 1\n---\nBody');
    one.destroy();
    // deleteLine takes the line break before the line: refused on the first body line, fine below it.
    v.dispatch({ selection: EditorSelection.cursor(body + 1) });
    deleteLine(v);
    expect(v.state.doc.toString()).toBe(doc);
    v.dispatch({ selection: EditorSelection.cursor(doc.length) });
    deleteLine(v);
    expect(v.state.doc.toString()).toBe('---\na: 1\n---\nBody');
    // Typing on the first body line still works.
    v.dispatch({ changes: { from: body, insert: 'X' }, selection: EditorSelection.cursor(body + 1), userEvent: 'input.type' });
    expect(v.state.doc.toString()).toBe('---\na: 1\n---\nXBody');
  });

  it('typing after a frontmatter with nothing below starts a new line', async () => {
    const doc = '---\na: 1\n---';
    const v = make(doc, 0);
    await Promise.resolve();
    expect(v.state.selection.main.head).toBe(doc.length);
    v.dispatch({ changes: { from: doc.length, insert: 'x' }, selection: EditorSelection.cursor(doc.length + 1), userEvent: 'input.type' });
    expect(v.state.doc.toString()).toBe('---\na: 1\n---\nx');
    expect(v.state.selection.main.head).toBe(v.state.doc.length);
    v.dispatch({ changes: { from: v.state.doc.length, insert: 'y' }, selection: EditorSelection.cursor(v.state.doc.length + 1), userEvent: 'input.type' });
    expect(v.state.doc.toString()).toBe('---\na: 1\n---\nxy');
  });

  it('a new link lookup (refreshLinks) renders the blocks again', () => {
    let current = files;
    const v = make('> [!note] T\n> [[Neu]]\n\nende', undefined, { lookup: () => current });
    expect(v.contentDOM.querySelector('.cm-preview-widget a.internal-link')?.classList.contains('is-unresolved')).toBe(true);
    current = createFileLookup(['Start.md', 'Neu.md']);
    v.dispatch({ effects: refreshLinks.of(null) });
    const a = v.contentDOM.querySelector<HTMLElement>('.cm-preview-widget a.internal-link')!;
    expect(a.classList.contains('is-unresolved')).toBe(false);
    expect(a.dataset.href).toBe('Neu.md');
  });

  it('clicking a checkbox toggles exactly that character and does not move the cursor', () => {
    const doc = '- [ ] eins\n- [x] zwei\n\nende';
    const v = make(doc);
    const boxes = v.contentDOM.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
    expect([...boxes].map((b) => b.checked)).toEqual([false, true]);
    down(boxes[0]!);
    expect(v.state.doc.toString()).toBe('- [x] eins\n- [x] zwei\n\nende');
    expect(v.state.selection.main.head).toBe(doc.length);
    down(v.contentDOM.querySelectorAll('input[type="checkbox"]')[1]!);
    expect(v.state.doc.toString()).toBe('- [x] eins\n- [ ] zwei\n\nende');
  });

  it('read-only notes: checkboxes do not change the text', () => {
    view = new EditorView({
      parent: document.body,
      state: EditorState.create({ doc: '- [ ] a\n\nb', selection: EditorSelection.cursor(10), extensions: [lang, EditorState.readOnly.of(true), livePreview(ctx)] }),
    });
    down(view.contentDOM.querySelector('input[type="checkbox"]')!);
    expect(view.state.doc.toString()).toBe('- [ ] a\n\nb');
  });

  it('images: /api/file URL with width; unresolved → placeholder; external → source stays', () => {
    const v = make('![[bild.jpg|300]]\n\n![](fehlt.png)\n\n![](https://example.com/x.png)\n\nende');
    const img = v.contentDOM.querySelector('img.cm-preview-widget')!;
    expect(img.getAttribute('src')).toBe('/api/file?path=bild.jpg');
    expect(img.getAttribute('width')).toBe('300');
    expect(v.contentDOM.querySelectorAll('img.cm-preview-widget')).toHaveLength(1);
    expect(v.contentDOM.querySelector('.cm-image-missing')?.textContent).toContain('nicht gefunden');
    expect(v.contentDOM.textContent).toContain('![](https://example.com/x.png)');
  });

  it('tables, callouts and math render through renderMarkdown (sanitized)', () => {
    const v = make('| a | <img src=x onerror=alert(1)> |\n|---|---|\n| **1** | <script>x()</script> |\n\n> [!warning] Achtung\n> Text\n\n$$\nx^2\n$$\n\nende');
    const table = v.contentDOM.querySelector('.cm-preview-widget table')!;
    expect(table.querySelector('strong')?.textContent).toBe('1');
    expect(v.contentDOM.querySelector('[onerror], script')).toBeNull();
    expect(v.contentDOM.querySelector('.cm-preview-widget .callout[data-callout="warning"]')).not.toBeNull();
    expect(v.contentDOM.querySelector('.cm-preview-widget .katex')).not.toBeNull();
    expect(v.contentDOM.textContent).not.toContain('[!warning]');
  });

  it('mermaid widgets hand their source to renderMermaid', () => {
    vi.mocked(renderMermaid).mockClear();
    const v = make('```mermaid\ngraph TD\nA-->B\n```\n\nende');
    const pre = v.contentDOM.querySelector('.cm-preview-widget pre.mermaid-src')!;
    expect(pre.textContent).toContain('A-->B');
    expect(renderMermaid).toHaveBeenCalledWith(pre.closest('.cm-preview-widget'));
  });

  it('`---` is drawn as a line; code blocks stay text', () => {
    const v = make('a\n\n---\n\n```js\nconst x = 1;\n```\n\nende');
    expect(v.contentDOM.querySelector('.cm-preview-widget hr')).not.toBeNull();
    expect(v.contentDOM.textContent).toContain('const x = 1;');
    expect(v.contentDOM.querySelector('.cm-codeblock')).not.toBeNull();
  });

  it('clicking a rendered block puts the cursor at its start (revealing the source)', () => {
    const doc = 'vorher\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nende';
    const v = make(doc);
    down(v.contentDOM.querySelector('.cm-preview-widget td')!);
    expect(v.state.selection.main.head).toBe(doc.indexOf('| a'));
    expect(v.contentDOM.querySelector('.cm-preview-widget table')).toBeNull();
    expect(v.contentDOM.textContent).toContain('| 1 | 2 |');
  });

  it('links inside a rendered block open via openLink (not by moving the cursor)', () => {
    const doc = '> [!note] T\n> siehe [[A#K]] und [[Fehlt]]\n\nende';
    const v = make(doc);
    const links = v.contentDOM.querySelectorAll<HTMLElement>('.cm-preview-widget a.internal-link');
    down(links[0]!);
    expect(openLink).toHaveBeenLastCalledWith('A.md', 'K', false, false);
    down(links[1]!, { ctrlKey: true });
    expect(openLink).toHaveBeenLastCalledWith('Fehlt', undefined, true, true);
    expect(v.state.selection.main.head).toBe(doc.length);
  });

  it('external links inside a rendered block open in a new tab, other schemes never', () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    try {
      const v = make('> [!note] T\n> [x](https://example.com) [y](javascript:alert(1))\n\nende');
      for (const a of v.contentDOM.querySelectorAll('.cm-preview-widget a')) down(a);
      expect(open.mock.calls).toEqual([['https://example.com', '_blank', 'noopener,noreferrer']]);
    } finally {
      open.mockRestore();
    }
  });

  it('middle click on a link in a widget opens it once (no second open by the browser)', () => {
    const v = make('> [!note] T\n> [[A]]\n\nende');
    const a = v.contentDOM.querySelector('.cm-preview-widget a.internal-link')!;
    down(a, { button: 1 });
    const aux = new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 });
    a.dispatchEvent(aux);
    expect(aux.defaultPrevented).toBe(true);
    expect(openLink).toHaveBeenCalledTimes(1);
    expect(openLink).toHaveBeenLastCalledWith('A.md', undefined, true, false);
  });

  it('tags in a widget call openTag (when given), never navigate', () => {
    const openTag = vi.fn();
    const v = make('> [!note] T\n> #projekt\n\nende', undefined, { openTag });
    const a = v.contentDOM.querySelector('.cm-preview-widget a.tag')!;
    down(a);
    const click = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
    a.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
    expect(openTag).toHaveBeenCalledWith('projekt');
    expect(openLink).not.toHaveBeenCalled();
  });

  it('inline embeds use a div container (rendered HTML has block elements)', () => {
    const v = make('Text ![[Notiz]] mehr\n\nende');
    const w = v.contentDOM.querySelector('.cm-embed-widget')!;
    expect(w.tagName).toBe('DIV');
    expect(w.classList.contains('is-inline')).toBe(true);
  });

  it('a task checkbox inside a callout toggles its own line', () => {
    const doc = 'x\n\n> [!todo] T\n> - [ ] a\n> - [ ] b\n\nende';
    const v = make(doc);
    const boxes = v.contentDOM.querySelectorAll('.cm-preview-widget input[type="checkbox"]');
    down(boxes[1]!);
    expect(v.state.doc.toString()).toBe('x\n\n> [!todo] T\n> - [ ] a\n> - [x] b\n\nende');
  });

  it('note embeds load the note and render it one level deeper', async () => {
    const v = make('![[Notiz]]\n\nende');
    await vi.waitFor(() => expect(v.contentDOM.querySelector('.cm-preview-widget .embed-content strong')?.textContent).toBe('Welt'));
    expect(loadNote).toHaveBeenCalledWith('Notiz.md');
  });

  it('the embed budget is per view and returned when a widget goes away', async () => {
    const v = make('![[Notiz]]\n\n![[Notiz]]\n\n![[A]]\n\nende');
    await vi.waitFor(() => expect(v.contentDOM.querySelectorAll('[data-embed-state="done"]')).toHaveLength(3));
    expect(embedBudgetLeft(v)).toBe(MAX_EMBEDS - 3);
    // Editing one embed (cursor on it) removes its widget: its budget comes back.
    v.dispatch({ selection: EditorSelection.cursor(2) });
    expect(embedBudgetLeft(v)).toBe(MAX_EMBEDS - 2);
    v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: 'leer' } });
    expect(embedBudgetLeft(v)).toBe(MAX_EMBEDS);
  });

  it('the view budget limits embeds shown at once', async () => {
    const v = make('![[Notiz]]\n\nende');
    await vi.waitFor(() => expect(v.contentDOM.querySelector('[data-embed-state="done"]')).not.toBeNull());
    // Use up the rest; the next embed drawn says so.
    const left = embedBudgetLeft(v);
    v.dispatch({ changes: { from: v.state.doc.length, insert: '\n\n' + Array.from({ length: left + 1 }, () => '![[A]]').join('\n\n') + '\n\nx' } });
    const states = [...v.contentDOM.querySelectorAll<HTMLElement>('[data-embed-state]')].map((e) => e.dataset.embedState);
    const drawnNew = states.length - 1;
    expect(states.filter((x) => x === 'over-budget')).toHaveLength(Math.max(0, drawnNew - left));
  });

  it('typing elsewhere reuses every unchanged widget (no re-render) in a long note', () => {
    const parts: string[] = [];
    for (let i = 0; i < 200; i++) {
      parts.push(i % 2 ? `| k${i} | v |\n|---|---|\n| 1 | 2 |` : `> [!note] N${i}\n> Text ${i}`);
      for (let j = 0; j < 22; j++) parts.push(`Zeile ${i}.${j} mit **fett**`);
    }
    const doc = parts.join('\n\n');
    expect(doc.split('\n').length).toBeGreaterThan(5000);
    // The cursor at the end; the start (with rendered blocks) is in view.
    const v = make(doc);
    const widgets = () => {
      const out: WidgetType[] = [];
      v.state.field(blockPreviewField).decorations.between(0, v.state.doc.length, (_f, _t, d) => {
        if (d.spec.widget) out.push(d.spec.widget as WidgetType);
      });
      return out;
    };
    const before = widgets();
    expect(before).toHaveLength(200);
    expect(v.contentDOM.querySelectorAll('.cm-preview-widget').length).toBeGreaterThan(0);
    const drawn = blockWidgetStats.drawn;
    const rendered = blockWidgetStats.rendered;
    for (const ch of 'abc') {
      const at = v.state.selection.main.head;
      v.dispatch({ changes: { from: at, insert: ch }, selection: EditorSelection.cursor(at + 1), userEvent: 'input.type' });
    }
    // Typing in the middle shifts every block below: still the same widgets.
    const mid = v.state.doc.line(2500);
    v.dispatch({ changes: { from: mid.from, insert: 'x' }, selection: EditorSelection.cursor(mid.from + 1), userEvent: 'input.type' });
    // An edit re-parses only a time slice; the rest follows in the background (done here at once).
    for (let i = 0; i < 20 && !syntaxTreeAvailable(v.state, v.state.doc.length); i++) {
      ensureSyntaxTree(v.state, v.state.doc.length, 5000);
      v.dispatch({});
    }
    const after = widgets();
    expect(after).toHaveLength(200);
    expect(after.every((w, i) => w.eq(before[i]!))).toBe(true);
    expect(blockWidgetStats.drawn).toBe(drawn);
    expect(blockWidgetStats.rendered).toBe(rendered);
  });

  it('decorates only the reported range (+ margin), not the whole note', () => {
    const doc = Array.from({ length: 3000 }, (_, i) => `- [ ] ${i}`).join('\n');
    const v = make(doc, 0);
    v.dispatch({ effects: setBlockRange.of({ from: 0, to: v.state.doc.line(50).to }) });
    const specs = v.state.field(blockPreviewField).specs;
    expect(specs.length).toBeGreaterThan(40);
    expect(specs.length).toBeLessThanOrEqual(50);
    // Typing keeps the range (mapped), the specs stay limited.
    v.dispatch({ changes: { from: v.state.doc.length, insert: 'x' } });
    expect(v.state.field(blockPreviewField).specs.length).toBeLessThan(500);
  });
});

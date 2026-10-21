/// <reference lib="dom" />
import { cursorCharRight, cursorLineDown } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { ensureSyntaxTree } from '@codemirror/language';
import { EditorSelection, EditorState, type SelectionRange } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFileLookup } from '@shared/resolve';
import { computeInlineDecorations, livePreviewContext, safeExternalHref, type LivePreviewContext } from '../../web/src/lib/editor/inline-hide';
import { livePreview } from '../../web/src/lib/editor/live-preview';
import { obsidianMarkdown } from '../../web/src/lib/editor/syntax';

const ctx: LivePreviewContext = {
  lookup: () => createFileLookup(['Start.md', 'A.md', 'Pfad/A.md', 'Ordner/Notiz.md']),
  path: 'Start.md',
  openLink: () => {},
};

const lang = markdown({ base: markdownLanguage, extensions: obsidianMarkdown });

/** `doc` followed by a separate paragraph `ende`; the cursor sits there unless `selection` is given. */
function stateOf(doc: string, selection?: EditorSelection | SelectionRange): EditorState {
  const full = doc + '\n\nende';
  const state = EditorState.create({
    doc: full,
    selection: selection ?? EditorSelection.cursor(full.length),
    extensions: [lang, livePreviewContext.of(ctx), EditorState.allowMultipleSelections.of(true)],
  });
  return parsedUpTo(state, state.doc.length);
}

/** `state` with its syntax tree parsed at least up to `pos` (as the view does for the visible part). */
function parsedUpTo(state: EditorState, pos: number): EditorState {
  ensureSyntaxTree(state, pos, 5000);
  // The language field picks up the parse progress on the next transaction.
  return state.update({}).state;
}

/** The text as shown: hidden ranges removed. */
function shown(state: EditorState): string {
  const { hide } = computeInlineDecorations(state);
  let out = '';
  let pos = 0;
  for (const h of [...hide].sort((a, b) => a.from - b.from)) {
    out += state.sliceDoc(pos, h.from);
    pos = Math.max(pos, h.to);
  }
  return (out + state.sliceDoc(pos)).replace(/\n\nende$/, '');
}

const marks = (state: EditorState) =>
  computeInlineDecorations(state).marks.map((m) => ({ cls: m.cls, text: state.sliceDoc(m.from, m.to), attrs: m.attrs }));

describe('computeInlineDecorations – hiding markup', () => {
  it('hides **bold** markers outside the cursor line and marks the text cm-strong', () => {
    const s = stateOf('ein **fett** Wort');
    expect(shown(s)).toBe('ein fett Wort');
    expect(marks(s)).toContainEqual({ cls: 'cm-strong', text: '**fett**', attrs: undefined });
  });

  it('hides nothing on the cursor line, but keeps the formatting', () => {
    const s = stateOf('ein **fett** Wort', EditorSelection.cursor(1));
    expect(shown(s)).toBe('ein **fett** Wort');
    expect(marks(s).map((m) => m.cls)).toContain('cm-strong');
  });

  it('shows the source of every line a selection touches (also multiple cursors)', () => {
    const doc = '**a**\n\n**b**\n\n**c**\n\n**d**';
    // Selection from line 1 into line 3; a second cursor on line 7.
    const s = stateOf(doc, EditorSelection.create([EditorSelection.range(2, 9), EditorSelection.cursor(doc.indexOf('**d') + 1)]));
    expect(shown(s)).toBe('**a**\n\n**b**\n\nc\n\n**d**');
  });

  it('wikilinks: alias only, cm-internal-link with data-href; unresolved also is-unresolved', () => {
    const s = stateOf('siehe [[Pfad/A|X]] und [[Fehlt]]');
    expect(shown(s)).toBe('siehe X und Fehlt');
    const m = marks(s);
    expect(m).toContainEqual({ cls: 'cm-internal-link', text: 'X', attrs: { 'data-href': 'Pfad/A.md' } });
    expect(m).toContainEqual({ cls: 'cm-internal-link is-unresolved', text: 'Fehlt', attrs: { 'data-href': 'Fehlt' } });
  });

  it('wikilinks without alias show the target, with subpath as data-subpath', () => {
    expect(shown(stateOf('[[A]]'))).toBe('A');
    const s = stateOf('[[A#Kopf]]');
    expect(shown(s)).toBe('A#Kopf');
    expect(marks(s)).toContainEqual({ cls: 'cm-internal-link', text: 'A#Kopf', attrs: { 'data-href': 'A.md', 'data-subpath': 'Kopf' } });
  });

  it('tags get cm-tag and stay visible', () => {
    const s = stateOf('a #projekt/x b');
    expect(shown(s)).toBe('a #projekt/x b');
    expect(marks(s)).toContainEqual({ cls: 'cm-tag', text: '#projekt/x', attrs: undefined });
  });

  it('highlight, strikethrough, emphasis and inline code: text visible, markers hidden', () => {
    const s = stateOf('==h== ~~s~~ *e* _f_ `c`');
    expect(shown(s)).toBe('h s e f c');
    expect(marks(s).map((m) => [m.cls, m.text])).toEqual(
      expect.arrayContaining([
        ['cm-highlight', '==h=='],
        ['cm-strikethrough', '~~s~~'],
        ['cm-em', '*e*'],
        ['cm-em', '_f_'],
        ['cm-inline-code', '`c`'],
      ]),
    );
  });

  it('markdown links: text visible with cm-link, URL hidden', () => {
    const s = stateOf('[Text](https://example.com/x "Titel") und <https://a.de>');
    expect(shown(s)).toBe('Text und https://a.de');
    expect(marks(s)).toContainEqual({ cls: 'cm-link', text: 'Text', attrs: { 'data-href': 'https://example.com/x' } });
    expect(marks(s)).toContainEqual({ cls: 'cm-link', text: 'https://a.de', attrs: { 'data-href': 'https://a.de' } });
  });

  it('only http(s) and mailto links get a data-href (never javascript:, data:, vbscript:)', () => {
    const bad = ['<javascript:alert(1)>', '<JavaScript:alert(1)>', '<data:text/html,x>', '<vbscript:msgbox(1)>', '[t](javascript:alert(1))'];
    for (const src of bad) {
      const m = marks(stateOf(`a ${src} b`));
      expect(m.length, src).toBe(1);
      expect(m[0]!.attrs, src).toBeUndefined();
    }
    expect(marks(stateOf('a <https://x> b'))).toEqual([{ cls: 'cm-link', text: 'https://x', attrs: { 'data-href': 'https://x' } }]);
    expect(marks(stateOf('a <mailto:a@b> b'))).toEqual([{ cls: 'cm-link', text: 'mailto:a@b', attrs: { 'data-href': 'mailto:a@b' } }]);
    expect(marks(stateOf('a www.x.de b'))).toEqual([{ cls: 'cm-link', text: 'www.x.de', attrs: { 'data-href': 'http://www.x.de' } }]);
  });

  it('safeExternalHref allows only http, https and mailto, ignoring leading control characters', () => {
    expect(safeExternalHref('https://x')).toBe('https://x');
    expect(safeExternalHref('MAILTO:a@b')).toBe('MAILTO:a@b');
    expect(safeExternalHref(' \u0001\thttp://x')).toBe('http://x');
    expect(safeExternalHref('javascript:alert(1)')).toBeNull();
    expect(safeExternalHref('\u0000 JavaScript:alert(1)')).toBeNull();
    expect(safeExternalHref('data:text/html,x')).toBeNull();
    expect(safeExternalHref('vbscript:x')).toBeNull();
  });

  it('markdown links to vault notes become internal links (relative to the note, URL-decoded)', () => {
    const s = stateOf('[N](Ordner/Notiz.md#Teil) [F](Neu%20da.md)');
    expect(shown(s)).toBe('N F');
    const m = marks(s);
    expect(m).toContainEqual({ cls: 'cm-internal-link', text: 'N', attrs: { 'data-href': 'Ordner/Notiz.md', 'data-subpath': 'Teil' } });
    expect(m).toContainEqual({ cls: 'cm-internal-link is-unresolved', text: 'F', attrs: { 'data-href': 'Neu da.md' } });
  });

  it('headings: # hidden, line class cm-h1 … cm-h6', () => {
    const s = stateOf('# Kopf\n\n### Drei ###');
    expect(shown(s)).toBe('Kopf\n\nDrei');
    const { lines } = computeInlineDecorations(s);
    expect(lines).toEqual([
      { from: 0, cls: 'cm-h1' },
      { from: 8, cls: 'cm-h3' },
    ]);
  });

  it('headings on the cursor line keep their # but also the line class', () => {
    const s = stateOf('# Kopf', EditorSelection.cursor(3));
    expect(shown(s)).toBe('# Kopf');
    expect(computeInlineDecorations(s).lines).toEqual([{ from: 0, cls: 'cm-h1' }]);
  });

  it('%%comments%% are dimmed (cm-comment), not hidden; formatting inside them is ignored', () => {
    const s = stateOf('a %%x **nicht** fett%% b');
    expect(shown(s)).toBe('a %%x **nicht** fett%% b');
    expect(marks(s)).toEqual([{ cls: 'cm-comment', text: '%%x **nicht** fett%%', attrs: undefined }]);
  });

  it('multi-line %% comment blocks are dimmed as a whole', () => {
    const s = stateOf('%%\n**a**\n\n# b\n%%');
    expect(shown(s)).toBe('%%\n**a**\n\n# b\n%%');
    expect(marks(s)).toEqual([{ cls: 'cm-comment', text: '%%\n**a**\n\n# b\n%%', attrs: undefined }]);
    expect(computeInlineDecorations(s).lines).toEqual([]);
  });

  it('escaped markers are no formatting; the backslash is hidden outside the cursor line', () => {
    const s = stateOf('\\*nicht fett\\*');
    expect(shown(s)).toBe('*nicht fett*');
    expect(marks(s)).toEqual([]);
  });

  it('markers inside inline code, code blocks and math stay text', () => {
    const doc = '`**a**` $x*y*z$ $$**b**$$\n\n```\n**c** [[A]] #t\n```\n\n$$\n**d** _e_\n$$';
    const s = stateOf(doc);
    expect(marks(s).map((m) => [m.cls, m.text])).toEqual([['cm-inline-code', '`**a**`']]);
    expect(shown(s)).toBe(doc.replace('`**a**`', '**a**'));
  });

  it('only computes the given ranges', () => {
    const s = stateOf('**a**\n\n**b**');
    const r = computeInlineDecorations(s, [{ from: 7, to: 12 }]);
    expect(r.marks.map((m) => s.sliceDoc(m.from, m.to))).toEqual(['**b**']);
    expect(r.hide).toEqual([
      { from: 7, to: 9 },
      { from: 10, to: 12 },
    ]);
  });
});

describe('livePreview in an EditorView', () => {
  let view: EditorView | undefined;
  afterEach(() => {
    view?.destroy();
    view = undefined;
  });

  function mount(doc: string, cursor: number, openLink = vi.fn()) {
    view = new EditorView({
      parent: document.body,
      state: EditorState.create({ doc, selection: EditorSelection.cursor(cursor), extensions: [lang, livePreview({ ...ctx, openLink })] }),
    });
    return { view, openLink };
  }

  const text = (v: EditorView) => v.contentDOM.textContent;

  it('renders formatting and reveals a line when the cursor moves onto it', () => {
    const { view } = mount('**a** x\n\n**b** y', 0);
    expect(text(view)).toBe('**a** xb y');
    expect([...view.contentDOM.querySelectorAll('.cm-strong')].map((e) => e.textContent)).toEqual(['**a**', 'b']);
    // Arrow down twice: onto line 3 – its markers appear, line 1 hides them.
    cursorLineDown(view);
    cursorLineDown(view);
    expect(view.state.doc.lineAt(view.state.selection.main.head).number).toBe(3);
    expect(text(view)).toBe('a x**b** y');
    // Arrow keys step through the revealed markup character by character (no stuck cursor).
    view.dispatch({ selection: EditorSelection.cursor(view.state.doc.line(3).from) });
    for (let i = 1; i <= 3; i++) {
      cursorCharRight(view);
      expect(view.state.selection.main.head).toBe(view.state.doc.line(3).from + i);
    }
  });

  it('a click on a link opens it (Mod-click in a new tab); unresolved links say so', () => {
    const { view, openLink } = mount('[[A#K|X]] [[Fehlt]]\n\nende', 22);
    const link = view.contentDOM.querySelector<HTMLElement>('.cm-internal-link')!;
    expect(link.textContent).toBe('X');
    link.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: 5, clientY: 5 }));
    window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0, clientX: 5, clientY: 5 }));
    expect(openLink).toHaveBeenLastCalledWith('A.md', 'K', false, false);
    // The click did not move the cursor into the link.
    expect(view.state.selection.main.head).toBe(22);

    const missing = view.contentDOM.querySelector<HTMLElement>('.is-unresolved')!;
    missing.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, ctrlKey: true }));
    window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));
    expect(openLink).toHaveBeenLastCalledWith('Fehlt', undefined, true, true);
  });

  it('clicking a javascript: autolink does nothing; an https one opens a new window', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    try {
      const doc = 'a <javascript:alert(1)> <JavaScript:x> <data:text/html,x> <vbscript:x> <https://x>\n\nende';
      const { view, openLink } = mount(doc, doc.length);
      const links = [...view.contentDOM.querySelectorAll<HTMLElement>('.cm-link')];
      expect(links.map((l) => l.textContent)).toEqual(['javascript:alert(1)', 'JavaScript:x', 'data:text/html,x', 'vbscript:x', 'https://x']);
      // The safe one first: a press on an unsafe one is a plain click into text (moves the cursor).
      for (const l of [links[4]!, ...links.slice(0, 4)]) {
        l.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
        window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));
      }
      expect(open.mock.calls).toEqual([['https://x', '_blank', 'noopener,noreferrer']]);
      expect(openLink).not.toHaveBeenCalled();
      // Even a tampered data-href is checked again before opening.
      view.dispatch({ selection: EditorSelection.cursor(doc.length) });
      links[4]!.dataset.href = 'javascript:alert(1)';
      links[4]!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
      window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));
      expect(open).toHaveBeenCalledTimes(1);
    } finally {
      open.mockRestore();
    }
  });

  it('a click on a link the cursor is already in edits it instead', () => {
    const { view, openLink } = mount('[[A]] b', 3);
    const link = view.contentDOM.querySelector<HTMLElement>('.cm-internal-link')!;
    link.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
    window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));
    expect(openLink).not.toHaveBeenCalled();
  });

  it('dragging from a link selects text instead of opening it', () => {
    const { view, openLink } = mount('[[A]] b\n\nende', 13);
    const link = view.contentDOM.querySelector<HTMLElement>('.cm-internal-link')!;
    link.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: 5, clientY: 5 }));
    window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, buttons: 1, clientX: 40, clientY: 5 }));
    window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0, clientX: 40, clientY: 5 }));
    expect(openLink).not.toHaveBeenCalled();
  });
});

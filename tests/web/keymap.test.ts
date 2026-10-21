/// <reference lib="dom" />
import { EditorSelection, EditorState } from '@codemirror/state';
import { EditorView, runScopeHandlers } from '@codemirror/view';
import { search } from '@codemirror/search';
import { keymap } from '@codemirror/view';
import { afterEach, describe, expect, it } from 'vitest';
import { obsidianKeymap } from '../../web/src/lib/editor/keymap';

let view: EditorView | undefined;
afterEach(() => view?.destroy());

/** Editor with `doc`; `|` marks the cursor, `<`…`>` a selection. */
function editor(doc: string, readOnly = false): EditorView {
  let anchor = doc.indexOf('|');
  let head = anchor;
  let text = doc.replace('|', '');
  if (anchor < 0) {
    anchor = doc.indexOf('<');
    head = doc.indexOf('>') - 1;
    text = doc.replace('<', '').replace('>', '');
  }
  view = new EditorView({
    parent: document.body,
    state: EditorState.create({
      doc: text,
      selection: { anchor, head },
      extensions: [keymap.of(obsidianKeymap), search(), EditorState.allowMultipleSelections.of(true), EditorState.readOnly.of(readOnly)],
    }),
  });
  return view;
}

function press(v: EditorView, key: string): void {
  const e = new KeyboardEvent('keydown', { key, ctrlKey: true, bubbles: true, cancelable: true });
  runScopeHandlers(v, e, 'editor');
}

const shown = (v: EditorView) => {
  const { anchor, head } = v.state.selection.main;
  const t = v.state.sliceDoc();
  return anchor === head ? t.slice(0, head) + '|' + t.slice(head) : t.slice(0, anchor) + '<' + t.slice(anchor, head) + '>' + t.slice(head);
};

describe('obsidianKeymap', () => {
  it('Mod-b: empty selection -> **** with the cursor inside', () => {
    const v = editor('a |b');
    press(v, 'b');
    expect(v.state.sliceDoc()).toBe('a ****b');
    expect(v.state.selection.main.head).toBe(4);
  });

  it('Mod-b wraps a selection and removes it again', () => {
    const v = editor('a <wort> b');
    press(v, 'b');
    expect(shown(v)).toBe('a **<wort>** b');
    press(v, 'b');
    expect(shown(v)).toBe('a <wort> b');
  });

  it('Mod-b removes markers that are part of the selection', () => {
    const v = editor('a <**wort**> b');
    press(v, 'b');
    expect(shown(v)).toBe('a <wort> b');
  });

  it('Mod-b on an empty **|** removes the markers', () => {
    const v = editor('a **|** b');
    press(v, 'b');
    expect(shown(v)).toBe('a | b');
  });

  it('Mod-i uses single stars and is not fooled by bold', () => {
    const v = editor('<wort>');
    press(v, 'i');
    expect(shown(v)).toBe('*<wort>*');
    press(v, 'i');
    expect(shown(v)).toBe('<wort>');
    const bold = editor('**<wort>**');
    press(bold, 'i');
    expect(shown(bold)).toBe('***<wort>***');
  });

  it('toggles every selection', () => {
    const v = editor('ab cd');
    v.dispatch({ selection: EditorSelection.create([EditorSelection.range(0, 2), EditorSelection.range(3, 5)]) });
    press(v, 'b');
    expect(v.state.sliceDoc()).toBe('**ab** **cd**');
    press(v, 'b');
    expect(v.state.sliceDoc()).toBe('ab cd');
  });

  it('Mod-k: selection -> [sel]() with the cursor in the parentheses', () => {
    const v = editor('x <Text> y');
    press(v, 'k');
    expect(shown(v)).toBe('x [Text](|) y');
  });

  it('Mod-k: no selection -> []() with the cursor in the brackets', () => {
    const v = editor('x | y');
    press(v, 'k');
    expect(shown(v)).toBe('x [|]() y');
  });

  it('Mod-Enter ticks and unticks a task', () => {
    const v = editor('- [ ] x|');
    press(v, 'Enter');
    expect(v.state.sliceDoc()).toBe('- [x] x');
    press(v, 'Enter');
    expect(v.state.sliceDoc()).toBe('- [ ] x');
  });

  it('Mod-Enter turns a normal line or list item into a task', () => {
    const v = editor('Text|');
    press(v, 'Enter');
    expect(v.state.sliceDoc()).toBe('- [ ] Text');
    const empty = editor('|');
    press(empty, 'Enter');
    expect(empty.state.sliceDoc()).toBe('- [ ] ');
    const item = editor('  - punkt|');
    press(item, 'Enter');
    expect(item.state.sliceDoc()).toBe('  - [ ] punkt');
  });

  it('does not change a read-only document, but still opens the search', () => {
    const v = editor('<wort>', true);
    press(v, 'b');
    press(v, 'k');
    expect(v.state.sliceDoc()).toBe('wort');
    press(v, 'f');
    expect(document.querySelector('.cm-search')).not.toBeNull();
  });
});

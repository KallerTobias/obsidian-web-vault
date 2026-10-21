import { openSearchPanel } from '@codemirror/search';
import { EditorSelection, type ChangeSpec } from '@codemirror/state';
import type { Command, EditorView, KeyBinding } from '@codemirror/view';
import { taskToggle } from './tasks';

/** Number of `ch` characters at the start (or, with `end`, the end) of `s`. */
function run(s: string, ch: string, end: boolean): number {
  let n = 0;
  while (n < s.length && s[end ? s.length - 1 - n : n] === ch) n++;
  return n;
}

/**
 * Is the mark `marker` set, given `na` marker characters before/at the start and `nb` after/at the end?
 * `*` is also part of `**`: italic only counts with an odd number of stars (`***x***` is bold+italic, `**x**` is not italic).
 */
function marked(marker: string, na: number, nb: number): boolean {
  return marker.length === 1 ? Math.min(na, nb) % 2 === 1 : na >= 2 && nb >= 2;
}

/** Mod-b / Mod-i: wraps each selection in `marker`; if already wrapped (outside or inside the selection), unwraps. */
const toggleMark =
  (marker: string): Command =>
  (view) => {
    if (view.state.readOnly) return false;
    const m = marker.length;
    const { doc } = view.state;
    view.dispatch(
      view.state.changeByRange((r) => {
        const near = 8; // enough context to count the stars around the selection
        const before = doc.sliceString(Math.max(0, r.from - near), r.from);
        const after = doc.sliceString(r.to, Math.min(doc.length, r.to + near));
        if (before.endsWith(marker) && after.startsWith(marker) && marked(marker, run(before, marker[0]!, true), run(after, marker[0]!, false))) {
          return {
            changes: [
              { from: r.from - m, to: r.from },
              { from: r.to, to: r.to + m },
            ],
            range: EditorSelection.range(r.from - m, r.to - m),
          };
        }
        const text = doc.sliceString(r.from, r.to);
        if (text.length >= 2 * m && text.startsWith(marker) && text.endsWith(marker) && marked(marker, run(text, marker[0]!, false), run(text, marker[0]!, true))) {
          return {
            changes: [
              { from: r.from, to: r.from + m },
              { from: r.to - m, to: r.to },
            ],
            range: EditorSelection.range(r.from, r.to - 2 * m),
          };
        }
        return {
          changes: [
            { from: r.from, insert: marker },
            { from: r.to, insert: marker },
          ],
          range: EditorSelection.range(r.from + m, r.to + m),
        };
      }),
      { userEvent: 'input', scrollIntoView: true },
    );
    return true;
  };

/** Mod-k: `[selection]()` with the cursor in the parentheses; without selection `[]()` with the cursor in the brackets. */
const insertLink: Command = (view) => {
  if (view.state.readOnly) return false;
  view.dispatch(
    view.state.changeByRange((r) => {
      const empty = r.empty;
      return {
        changes: [
          { from: r.from, insert: '[' },
          { from: r.to, insert: empty ? ']()' : '](' },
          ...(empty ? [] : [{ from: r.to, insert: ')' }]),
        ],
        range: EditorSelection.cursor(empty ? r.from + 1 : r.to + 3),
      };
    }),
    { userEvent: 'input', scrollIntoView: true },
  );
  return true;
};

/** `  - `, `1. ` (also in block quotes) of a list item without a box: where `[ ] ` goes. */
const LIST_ITEM = /^(?:[ \t]*>)*[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+/;
const INDENT = /^(?:[ \t]*>)*[ \t]*/;

/** Mod-Enter: ticks/unticks a task item; turns a list item or plain line into an open task. */
const toggleTask: Command = (view) => {
  if (view.state.readOnly) return false;
  const { doc } = view.state;
  const changes: ChangeSpec[] = [];
  const seen = new Set<number>();
  for (const r of view.state.selection.ranges) {
    for (let n = doc.lineAt(r.from).number; n <= doc.lineAt(r.to).number; n++) {
      if (seen.has(n)) continue;
      seen.add(n);
      const line = doc.line(n);
      // A selection ending at the start of a line does not include that line.
      if (n > doc.lineAt(r.from).number && r.to === line.from) continue;
      const toggle = taskToggle(line.text, 0);
      if (toggle) changes.push({ from: line.from + toggle.from, to: line.from + toggle.to, insert: toggle.insert });
      else if (line.text.trim() === '' && r.from !== r.to) continue;
      else {
        const item = LIST_ITEM.exec(line.text);
        if (item) changes.push({ from: line.from + item[0].length, insert: '[ ] ' });
        else changes.push({ from: line.from + INDENT.exec(line.text)![0].length, insert: '- [ ] ' });
      }
    }
  }
  if (changes.length === 0) return false;
  view.dispatch({ changes, userEvent: 'input', scrollIntoView: true });
  return true;
};

const openSearch: Command = (view: EditorView) => openSearchPanel(view);

/**
 * Obsidian's shortcuts in the editor: Mod-b bold, Mod-i italic, Mod-k link, Mod-Enter task, Mod-f search,
 * Mod-h replace (the search panel has both fields). Mod-e (reading/editing) and Mod-o/Mod-p are handled
 * app-wide, not here, so they also work with the focus outside of the editor.
 */
export const obsidianKeymap: KeyBinding[] = [
  { key: 'Mod-b', run: toggleMark('**'), preventDefault: true },
  { key: 'Mod-i', run: toggleMark('*'), preventDefault: true },
  { key: 'Mod-k', run: insertLink, preventDefault: true },
  { key: 'Mod-Enter', run: toggleTask, preventDefault: true },
  { key: 'Mod-f', run: openSearch, preventDefault: true },
  { key: 'Mod-h', run: openSearch, preventDefault: true },
];

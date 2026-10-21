/// <reference lib="dom" />
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { syntaxTree } from '@codemirror/language';
import { EditorState } from '@codemirror/state';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { lineDiff } from '../../web/src/lib/editor/diff';
import { createEditor, type EditorHandle } from '../../web/src/lib/editor/setup';
import { obsidianMarkdown } from '../../web/src/lib/editor/syntax';
import { taskToggle } from '../../web/src/lib/editor/tasks';

describe('Obsidian syntax', () => {
  const nodes = (doc: string) => {
    const state = EditorState.create({ doc, extensions: markdown({ base: markdownLanguage, extensions: obsidianMarkdown }) });
    const out: string[] = [];
    syntaxTree(state).iterate({
      enter: (n) => {
        if (['WikiLink', 'Tag', 'Highlight'].includes(n.name)) out.push(`${n.name}:${doc.slice(n.from, n.to)}`);
      },
    });
    return out;
  };

  it('knows wikilinks, embeds, tags and highlights', () => {
    expect(nodes('a [[Ziel|Text]] ![[Bild.png]] #projekt/ä und ==wichtig== x')).toEqual([
      'WikiLink:[[Ziel|Text]]',
      'WikiLink:![[Bild.png]]',
      'Tag:#projekt/ä',
      'Highlight:==wichtig==',
    ]);
  });

  it('no tags inside words or of digits only, no empty links', () => {
    expect(nodes('a#b #123 [[]]')).toEqual([]);
  });

  const all = (doc: string, names: string[]) => {
    const state = EditorState.create({ doc, extensions: markdown({ base: markdownLanguage, extensions: obsidianMarkdown }) });
    const out: string[] = [];
    syntaxTree(state).iterate({
      enter: (n) => {
        if (names.includes(n.name)) out.push(`${n.name}:${doc.slice(n.from, n.to)}`);
      },
    });
    return out;
  };
  const kinds = ['InlineMath', 'BlockMath', 'ObsidianComment', 'ObsidianCommentBlock', 'Emphasis', 'StrongEmphasis'];

  it('knows inline and block math; nothing inside is formatting', () => {
    expect(all('a $x*y*z$ b $$**c**$$ 5$ und 6$', kinds)).toEqual(['InlineMath:$x*y*z$', 'InlineMath:$$**c**$$']);
    expect(all('$ a$ $b $', kinds)).toEqual([]);
    expect(all('$$\n*a*\n\n*b*\n$$\n*c*', kinds)).toEqual(['BlockMath:$$\n*a*\n\n*b*\n$$', 'Emphasis:*c*']);
    // An unclosed block ends with its container.
    expect(all('> $$\n> *a*\n\n*b*', kinds)).toEqual(['BlockMath:$$\n> *a*', 'Emphasis:*b*']);
  });

  it('knows %% comments inline and across lines; nothing inside is formatting', () => {
    expect(all('a %%x *y*%% *z*', kinds)).toEqual(['ObsidianComment:%%x *y*%%', 'Emphasis:*z*']);
    expect(all('%%\n*a*\n\n# b\n%% \n*c*', kinds)).toEqual(['ObsidianCommentBlock:%%\n*a*\n\n# b\n%% ', 'Emphasis:*c*']);
    expect(all('%%x%% *y*', kinds)).toEqual(['ObsidianComment:%%x%%', 'Emphasis:*y*']);
  });
});

describe('taskToggle', () => {
  const apply = (text: string, line: number) => {
    const c = taskToggle(text, line);
    return c ? text.slice(0, c.from) + c.insert + text.slice(c.to) : null;
  };

  it('ticks and unticks task items of all list kinds', () => {
    expect(apply('# T\n- [ ] a\n', 1)).toBe('# T\n- [x] a\n');
    expect(apply('- [x] a', 0)).toBe('- [ ] a');
    expect(apply('- [X] a', 0)).toBe('- [ ] a');
    expect(apply('  * [ ] a', 0)).toBe('  * [x] a');
    expect(apply('+ [ ] a', 0)).toBe('+ [x] a');
    expect(apply('12. [ ] a', 0)).toBe('12. [x] a');
    expect(apply('3) [ ] a', 0)).toBe('3) [x] a');
    expect(apply('> - [ ] a', 0)).toBe('> - [x] a');
  });

  it('keeps CRLF line endings', () => {
    expect(apply('a\r\n- [ ] b\r\nc', 1)).toBe('a\r\n- [x] b\r\nc');
  });

  it('ignores lines that are no task items', () => {
    expect(taskToggle('- a', 0)).toBeNull();
    expect(taskToggle('[ ] a', 0)).toBeNull();
    expect(taskToggle('- [-] a', 0)).toBeNull();
    expect(taskToggle('-[ ] a', 0)).toBeNull();
    expect(taskToggle('a', 5)).toBeNull();
    expect(taskToggle('a', -1)).toBeNull();
  });
});

describe('lineDiff', () => {
  it('marks lines only in mine and lines only on disk', () => {
    expect(lineDiff('a\nb\nc', 'a\nB\nc\nd')).toEqual([
      { type: 'same', text: 'a' },
      { type: 'mine', text: 'b' },
      { type: 'disk', text: 'B' },
      { type: 'same', text: 'c' },
      { type: 'disk', text: 'd' },
    ]);
  });

  it('handles equal and empty texts', () => {
    expect(lineDiff('a', 'a')).toEqual([{ type: 'same', text: 'a' }]);
    expect(lineDiff('', 'x')).toEqual([
      { type: 'mine', text: '' },
      { type: 'disk', text: 'x' },
    ]);
  });

  it('ignores CR so CRLF vs LF shows no difference', () => {
    expect(lineDiff('a\r\nb', 'a\nb').every((l) => l.type === 'same')).toBe(true);
  });

  it('handles big texts', () => {
    const big = Array.from({ length: 20_000 }, (_, i) => `line ${i}`).join('\n');
    const other = Array.from({ length: 20_000 }, (_, i) => `other ${i}`).join('\n');
    expect(lineDiff(big, other).filter((l) => l.type === 'mine')).toHaveLength(20_000);
  });
});

describe('createEditor', () => {
  let handle: EditorHandle | undefined;
  afterEach(() => {
    handle?.destroy();
    handle = undefined;
  });

  function make(doc: string, readonly = false) {
    const parent = document.createElement('div');
    document.body.append(parent);
    const onChange = vi.fn();
    handle = createEditor(parent, { doc, mode: 'live', readonly, path: 'A.md', onChange });
    return { parent, onChange, view: handle.view };
  }

  it('reports user changes', () => {
    const { view, onChange } = make('hello');
    view.dispatch({ changes: { from: 5, insert: '!' }, userEvent: 'input' });
    expect(onChange).toHaveBeenCalledWith('hello!');
  });

  it('replaceDoc does not report a change and keeps the cursor by line and column', () => {
    const { view, onChange } = make('a\nbbbb\nc');
    view.dispatch({ selection: { anchor: 5 } }); // line 2, column 3
    handle!.replaceDoc('x\nyyyyyy\nz\n', true);
    expect(onChange).not.toHaveBeenCalled();
    expect(view.state.doc.toString()).toBe('x\nyyyyyy\nz\n');
    expect(view.state.selection.main.head).toBe(5);
    // Clamped when the line got shorter or vanished.
    handle!.replaceDoc('q', true);
    expect(view.state.selection.main.head).toBe(1);
  });

  it('keeps CRLF line endings', () => {
    const { view, onChange } = make('a\r\nb\r\n');
    view.dispatch({ changes: { from: 1, insert: '!' }, userEvent: 'input' });
    expect(onChange).toHaveBeenCalledWith('a!\r\nb\r\n');
  });

  it('readonly editors refuse input', () => {
    const { view } = make('a', true);
    expect(view.state.readOnly).toBe(true);
  });

  it('switches mode without losing the text', () => {
    const { parent, view } = make('---\na: 1\n---\ntext');
    handle!.setMode('source');
    expect(parent.querySelector('.cm-editor')?.classList.contains('is-source')).toBe(true);
    handle!.setMode('live');
    expect(parent.querySelector('.cm-editor')?.classList.contains('is-source')).toBe(false);
    expect(view.state.doc.toString()).toBe('---\na: 1\n---\ntext');
  });
});

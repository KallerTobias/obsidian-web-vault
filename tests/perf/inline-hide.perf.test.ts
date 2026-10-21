import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { ensureSyntaxTree } from '@codemirror/language';
import { EditorState } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import { createFileLookup } from '@shared/resolve';
import { computeInlineDecorations, livePreviewContext, type LivePreviewContext } from '../../web/src/lib/editor/inline-hide';
import { obsidianMarkdown } from '../../web/src/lib/editor/syntax';

/* Wall-clock budgets: in the `perf` project (`npm run test:perf`), not in `npm test`, where parallel test files make them flaky. */

const ctx: LivePreviewContext = {
  lookup: () => createFileLookup(['Start.md', 'A.md', 'Pfad/A.md', 'Ordner/Notiz.md']),
  path: 'Start.md',
  openLink: () => {},
};
const lang = markdown({ base: markdownLanguage, extensions: obsidianMarkdown });

function parsedUpTo(state: EditorState, pos: number): EditorState {
  ensureSyntaxTree(state, pos, 5000);
  return state.update({}).state;
}

describe('live preview performance', () => {
  it('a 5,000-line note: the visible range takes less than 30 ms', () => {
    const lines: string[] = [];
    for (let i = 0; i < 5000; i++) {
      const k = i % 6;
      if (k === 0) lines.push(`## Abschnitt ${i}`);
      else if (k === 1) lines.push(`- [ ] Aufgabe ${i} mit [[Notiz]] und #tag/${i}`);
      else if (k === 2) lines.push(`Text **fett** ==hell== und [Link](https://example.com/${i}) $x_${i}$`);
      else if (k === 3) lines.push('');
      else lines.push(`Zeile ${i} mit *etwas* Text, einem [[Ordner/Notiz|Alias]] und \`code\`.`);
    }
    const doc = lines.join('\n');
    let state = EditorState.create({ doc, extensions: [lang, livePreviewContext.of(ctx)] });
    // A screen of text in the middle of the note (the view parses at least that far).
    const from = state.doc.line(2500).from;
    const to = state.doc.line(2580).to;
    state = parsedUpTo(state, to);
    for (let i = 0; i < 5; i++) computeInlineDecorations(state, [{ from, to }]); // warm-up
    const times: number[] = [];
    for (let i = 0; i < 5; i++) {
      const t0 = performance.now();
      const r = computeInlineDecorations(state, [{ from, to }]);
      times.push(performance.now() - t0);
      expect(r.marks.length).toBeGreaterThan(50);
    }
    expect(times.sort((a, b) => a - b)[2]).toBeLessThan(30);
  });});

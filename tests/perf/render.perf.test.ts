import remarkParse from 'remark-parse';
import { unified } from 'unified';
import { describe, expect, it } from 'vitest';
import { createFileLookup } from '@shared/resolve';
import { renderMarkdown } from '../../web/src/lib/markdown/render';

/*
 * Runs in the `perf` project: dependencies load their production builds (micromark & co. ship
 * `development` builds full of assertions, which vitest would otherwise pick, ~2x slower).
 *
 * The plan's target was "< 100 ms for 1,000 lines". On the VPS, plain `remark-parse` alone needs ~145 ms
 * for this note, so an absolute bound measures the machine, not our code. The test therefore compares
 * the whole pipeline against the bare CommonMark parse on the same machine: everything we add (GFM,
 * math, Obsidian syntax, sanitizing, KaTeX, stringify) may cost at most as much again as the parse
 * itself (×2), plus slack for noisy machines (×2.6). Not part of `npm test`: run `npm run test:perf`.
 */
const lookup = createFileLookup(['Start.md', 'Notiz.md', 'Ordner/Notiz A.md']);
const ctx = { path: 'Start.md', lookup };

function median(fn: () => void): number {
  for (let i = 0; i < 8; i++) fn(); // warm-up (JIT)
  const times: number[] = [];
  for (let i = 0; i < 5; i++) {
    const t0 = performance.now();
    fn();
    times.push(performance.now() - t0);
  }
  return times.sort((a, b) => a - b)[2]!;
}

describe('renderMarkdown – performance', () => {
  it('renders a 1,000-line note in less than 2.6× the time of a bare CommonMark parse', { timeout: 60_000 }, () => {
    const lines: string[] = [];
    for (let i = 0; i < 1000; i++) {
      const k = i % 10;
      if (k === 0) lines.push(`## Abschnitt ${i}`);
      else if (k === 1) lines.push(`- [ ] Aufgabe ${i} mit [[Notiz]] und #tag/${i}`);
      else if (k === 2) lines.push(`Text **fett** ==hell== und [Link](https://example.com/${i}) $x_${i}$`);
      else if (k === 3) lines.push('');
      else lines.push(`Zeile ${i} mit etwas Text, einem [[Ordner/Notiz A|Alias]] und \`code\`.`);
    }
    const text = lines.join('\n');
    const bare = unified().use(remarkParse);
    const parseMs = median(() => bare.parse(text));
    const renderMs = median(() => renderMarkdown(text, ctx));
    const measured = `render ${renderMs.toFixed(1)} ms, bare parse ${parseMs.toFixed(1)} ms (×${(renderMs / parseMs).toFixed(2)})`;
    expect(renderMs, measured).toBeLessThan(parseMs * 2.6);
  });
});

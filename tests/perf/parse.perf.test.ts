import { describe, expect, it } from 'vitest';
import { parseNote } from '@shared/parse';

/* Wall-clock budgets: in the `perf` project (`npm run test:perf`), not in `npm test`, where parallel test files make them flaky. */

describe('parseNote performance', () => {
  it('parses 5000 typical notes (~61 lines, ~19 wikilinks, ~19 markdown links, ~19 tags) quickly', () => {
    const linkLine = 'Lorem [[Link|x]] ipsum [t](Ordner/a%20b.md#h) dolor #tag sit `c` ^b1\n';
    const plain = 'Plain prose line with some words and more words in it, nothing special here at all.\nAnother ordinary sentence of text without anything.\n';
    const note = '---\ntags: [a]\n---\n# T\n' + (linkLine + plain).repeat(20);
    const run = (): number => {
      const start = performance.now();
      for (let i = 0; i < 5000; i++) parseNote(note);
      return performance.now() - start;
    };
    run(); // warm-up
    const median = [run(), run(), run()].sort((a, b) => a - b)[1]!;
    expect(median).toBeLessThan(1000);
  });
});

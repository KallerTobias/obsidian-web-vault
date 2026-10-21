import { describe, expect, it } from 'vitest';
import { lineDiff } from '../../web/src/lib/editor/diff';

/* Wall-clock budgets: in the `perf` project (`npm run test:perf`), not in `npm test`, where parallel test files make them flaky. */

describe('lineDiff performance', () => {
  it('diffs 20,000 changed lines in < 1 s', () => {
    const big = Array.from({ length: 20_000 }, (_, i) => `line ${i}`).join('\n');
    const other = Array.from({ length: 20_000 }, (_, i) => `other ${i}`).join('\n');
    const t = performance.now();
    lineDiff(big, other);
    expect(performance.now() - t).toBeLessThan(1000);
  });
});

import { describe, expect, it } from 'vitest';
import { SearchIndex } from '../../server/index/search';

/* Wall-clock budgets: in the `perf` project (`npm run test:perf`), not in `npm test`, where parallel test files make them flaky. */

describe('SearchIndex performance (5000 notes)', () => {
  it('indexes quickly and searches fast', () => {
    const words = ['server', 'zelt', 'netzwerk', 'backup', 'dachzelt', 'projekt', 'idee', 'küche', 'reise', 'plan'];
    const idx = new SearchIndex();
    const t0 = performance.now();
    for (let i = 0; i < 5000; i++) {
      const body = Array.from({ length: 40 }, (_, j) => words[(i * 7 + j * 3) % words.length]! + (j % 11)).join(' ');
      idx.upsert(`Ordner${i % 50}/Notiz ${i}.md`, `# Notiz ${i}\n${body}`, ['t' + (i % 20)]);
    }
    const indexMs = performance.now() - t0;
    idx.search('warmup');
    const times: number[] = [];
    let hits: ReturnType<SearchIndex['search']> = [];
    for (let k = 0; k < 5; k++) {
      const t1 = performance.now();
      hits = idx.search('zelt tag:t3 -plan99');
      times.push(performance.now() - t1);
    }
    const searchMs = Math.min(...times); // best of 5 (robust against GC/parallel-test noise)
    expect(hits.length).toBeGreaterThan(0);
    expect(indexMs).toBeLessThan(1500);
    expect(searchMs).toBeLessThan(50);
  });
});

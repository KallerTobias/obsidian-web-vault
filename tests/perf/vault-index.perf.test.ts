import { describe, expect, it } from 'vitest';
import { VaultIndex } from '../../server/index/vault-index';

/* Wall-clock budgets: in the `perf` project (`npm run test:perf`), not in `npm test`, where parallel test files make them flaky. */

describe('VaultIndex performance', () => {
  it('builds 5000 notes x 20 links in < 2 s; one upsert < 20 ms', () => {
    const N = 5000;
    const texts: string[] = [];
    let seed = 1;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    for (let i = 0; i < N; i++) {
      let s = `---\ntags: [t${i % 50}]\n---\n# Notiz ${i}\n`;
      for (let k = 0; k < 20; k++) s += `Text [[Notiz ${Math.floor(rnd() * N)}]] mehr\n`;
      texts.push(s);
    }
    const ix = new VaultIndex();
    const t0 = performance.now();
    for (let i = 0; i < N; i++) ix.upsert(`Ordner${i % 50}/Notiz ${i}.md`, texts[i]!);
    const build = performance.now() - t0;
    const t1 = performance.now();
    ix.upsert('Ordner1/Notiz 1.md', texts[2]! + '[[Neu]]');
    const one = performance.now() - t1;
    console.log(`build ${build.toFixed(0)} ms, upsert ${one.toFixed(1)} ms`);
    expect(build).toBeLessThan(2000);
    expect(one).toBeLessThan(20);
    expect(ix.backlinks('Ordner0/Notiz 0.md').length).toBeGreaterThanOrEqual(0);
  });
});

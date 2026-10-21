import { describe, expect, it } from 'vitest';
import type { GraphData, Settings } from '../../web/src/lib/api';
import { colorFor, filterGraph, localGraph } from '../../web/src/lib/graph/data';

/* Wall-clock budgets: in the `perf` project (`npm run test:perf`), not in `npm test`. */

function generate(notes: number): GraphData {
  const nodes: GraphData['nodes'] = [];
  const links: GraphData['links'] = [];
  const folders = ['Homelab', 'NXTZLT', 'NXTLYR', 'Privat', 'Archiv/Alt'];
  for (let i = 0; i < notes; i++) {
    const folder = folders[i % folders.length]!;
    nodes.push({ id: `${folder}/Notiz ${i}.md`, name: `Notiz ${i}`, kind: 'note', tags: [`t${i % 40}`], folder, degree: 0 });
  }
  for (let t = 0; t < 40; t++) nodes.push({ id: `tag:#t${t}`, name: `#t${t}`, kind: 'tag', tags: [], folder: '', degree: 0 });
  for (let u = 0; u < 200; u++) nodes.push({ id: `unresolved:Fehlt ${u}`, name: `Fehlt ${u}`, kind: 'unresolved', tags: [], folder: '', degree: 0 });
  for (let i = 0; i < notes; i++) {
    const src = nodes[i]!.id;
    for (const k of [1, 7, 31]) links.push({ source: src, target: nodes[(i * k + 13) % notes]!.id });
    links.push({ source: src, target: `tag:#t${i % 40}` });
    if (i % 25 === 0) links.push({ source: src, target: `unresolved:Fehlt ${i % 200}` });
  }
  const byId = new Map(nodes.map((n) => [n.id, n]));
  for (const l of links) {
    byId.get(l.source)!.degree++;
    byId.get(l.target)!.degree++;
  }
  return { nodes, links };
}

const settings: Settings['graph'] = {
  mode: '2d',
  filter: '-path:Archiv notiz',
  showTags: true,
  showAttachments: true,
  showOrphans: false,
  groups: [
    { query: 'path:Homelab', color: '#e03131' },
    { query: 'path:NXTZLT', color: '#2f9e44' },
    { query: 'path:NXTLYR', color: '#1971c2' },
    { query: 'path:Privat', color: '#f08c00' },
  ],
  repel: 1,
  linkDistance: 1,
  center: 1,
  nodeSize: 1,
  localDepth: 2,
};

const best = (fn: () => void) => {
  fn(); // warm-up
  const times: number[] = [];
  for (let k = 0; k < 5; k++) {
    const t = performance.now();
    fn();
    times.push(performance.now() - t);
  }
  return Math.min(...times);
};

describe('graph data performance (5000 notes)', () => {
  const data = generate(5000);

  it('filterGraph < 50 ms', () => {
    let out: GraphData = { nodes: [], links: [] };
    const ms = best(() => (out = filterGraph(data, settings)));
    expect(out.nodes.length).toBeGreaterThan(3000);
    expect(ms).toBeLessThan(50);
  });

  it('localGraph (depth 2) < 50 ms', () => {
    let out: GraphData = { nodes: [], links: [] };
    const ms = best(() => (out = localGraph(data, data.nodes[0]!.id, 2)));
    expect(out.nodes.length).toBeGreaterThan(1);
    expect(ms).toBeLessThan(50);
  });

  it('colouring all nodes by four groups < 50 ms', () => {
    const ms = best(() => {
      for (const n of data.nodes) colorFor(n, settings.groups);
    });
    expect(ms).toBeLessThan(50);
  });
});

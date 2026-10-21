import { describe, expect, it } from 'vitest';
import type { GraphData, Settings } from '../../web/src/lib/api';
import { adjacency, colorFor, filterGraph, localGraph, nodeRadius, withPositions } from '../../web/src/lib/graph/data';

type Node = GraphData['nodes'][number];

const note = (id: string, degree = 1, tags: string[] = []): Node => ({
  id,
  name: id.replace(/^.*\//, '').replace(/\.md$/, ''),
  kind: 'note',
  tags,
  folder: id.includes('/') ? id.slice(0, id.lastIndexOf('/')) : '',
  degree,
});
const tag = (t: string, degree = 1): Node => ({ id: `tag:#${t}`, name: `#${t}`, kind: 'tag', tags: [], folder: '', degree });
const unresolved = (name: string, degree = 1): Node => ({ id: `unresolved:${name}`, name, kind: 'unresolved', tags: [], folder: '', degree });
const attachment = (id: string, degree = 1): Node => ({ id, name: id.replace(/^.*\//, ''), kind: 'attachment', tags: [], folder: '', degree });
const link = (source: string, target: string) => ({ source, target });

const settings = (s: Partial<Settings['graph']> = {}): Settings['graph'] => ({
  mode: '2d',
  filter: '',
  showTags: true,
  showAttachments: true,
  showOrphans: true,
  groups: [],
  repel: 1,
  linkDistance: 1,
  center: 1,
  nodeSize: 1,
  localDepth: 1,
  ...s,
});

const ids = (g: GraphData) => g.nodes.map((n) => n.id).sort();
const linkIds = (g: GraphData) => g.links.map((l) => `${l.source}->${l.target}`).sort();

const sample: GraphData = {
  nodes: [
    note('Homelab/Server.md', 3, ['infra']),
    note('Homelab/Netz.md', 1),
    note('Privat/Reise.md', 2, ['urlaub']),
    note('Einsam.md', 0),
    tag('infra'),
    tag('urlaub'),
    unresolved('Fehlt'),
    attachment('Homelab/plan.png'),
  ],
  links: [
    link('Homelab/Server.md', 'Homelab/Netz.md'),
    link('Homelab/Server.md', 'tag:#infra'),
    link('Homelab/Server.md', 'Homelab/plan.png'),
    link('Privat/Reise.md', 'tag:#urlaub'),
    link('Privat/Reise.md', 'unresolved:Fehlt'),
  ],
};

describe('filterGraph', () => {
  it('keeps everything with all switches on and no filter', () => {
    const g = filterGraph(sample, settings());
    expect(ids(g)).toEqual(ids(sample));
    expect(g.links).toHaveLength(sample.links.length);
  });

  it('showTags:false removes tag nodes and their links', () => {
    const g = filterGraph(sample, settings({ showTags: false }));
    expect(ids(g)).not.toContain('tag:#infra');
    expect(ids(g)).not.toContain('tag:#urlaub');
    expect(linkIds(g)).toEqual([
      'Homelab/Server.md->Homelab/Netz.md',
      'Homelab/Server.md->Homelab/plan.png',
      'Privat/Reise.md->unresolved:Fehlt',
    ]);
  });

  it('showAttachments:false removes attachments and their links', () => {
    const g = filterGraph(sample, settings({ showAttachments: false }));
    expect(ids(g)).not.toContain('Homelab/plan.png');
    expect(linkIds(g)).not.toContain('Homelab/Server.md->Homelab/plan.png');
  });

  it('showOrphans:false removes nodes with degree 0', () => {
    const g = filterGraph(sample, settings({ showOrphans: false }));
    expect(ids(g)).not.toContain('Einsam.md');
    expect(ids(g)).toContain('Homelab/Netz.md');
  });

  it('showOrphans:false also removes notes whose only links are hidden (tags off)', () => {
    const data: GraphData = { nodes: [note('A.md', 1, ['x']), tag('x')], links: [link('A.md', 'tag:#x')] };
    expect(ids(filterGraph(data, settings({ showOrphans: false, showTags: false })))).toEqual([]);
  });

  it('filter path:Homelab keeps only matching notes (and links among them)', () => {
    const g = filterGraph(sample, settings({ filter: 'path:Homelab', showTags: false }));
    expect(ids(g)).toEqual(['Homelab/Netz.md', 'Homelab/Server.md', 'Homelab/plan.png']);
    expect(linkIds(g)).toEqual(['Homelab/Server.md->Homelab/Netz.md', 'Homelab/Server.md->Homelab/plan.png']);
  });

  it('tag nodes stay with the filter when a kept note carries them', () => {
    const g = filterGraph(sample, settings({ filter: 'path:Homelab' }));
    expect(ids(g)).toContain('tag:#infra');
    expect(ids(g)).not.toContain('tag:#urlaub');
  });

  it('unresolved nodes only when the filter does not exclude them', () => {
    expect(ids(filterGraph(sample, settings({ filter: 'path:Privat' })))).not.toContain('unresolved:Fehlt');
    expect(ids(filterGraph(sample, settings({ filter: '-path:Homelab' })))).toContain('unresolved:Fehlt');
    expect(ids(filterGraph(sample, settings({ filter: 'Fehlt' })))).toEqual(['unresolved:Fehlt']);
  });

  it('text terms match the name, tag: terms the tags; negation works', () => {
    expect(ids(filterGraph(sample, settings({ filter: 'reise', showTags: false })))).toEqual(['Privat/Reise.md']);
    expect(ids(filterGraph(sample, settings({ filter: 'tag:#infra', showTags: false })))).toEqual(['Homelab/Server.md']);
    expect(ids(filterGraph(sample, settings({ filter: '-path:Homelab -path:Privat', showTags: false })))).toEqual([
      'Einsam.md',
      'unresolved:Fehlt',
    ]);
  });

  it('returns fresh link objects with string ids (the graph libraries replace them with node objects)', () => {
    const g = filterGraph(sample, settings());
    expect(g.links[0]).not.toBe(sample.links[0]);
    expect(typeof g.links[0]!.source).toBe('string');
  });
});

describe('colorFor', () => {
  const groups = [
    { query: 'path:Homelab', color: '#ff0000' },
    { query: 'tag:infra', color: '#00ff00' },
  ];

  it('the first matching group wins', () => {
    expect(colorFor(note('Homelab/Server.md', 1, ['infra']), groups)).toBe('#ff0000');
    expect(colorFor(note('Homelab/Server.md', 1, ['infra']), [...groups].reverse())).toBe('#00ff00');
  });

  it('null without a matching group; empty queries match nothing', () => {
    expect(colorFor(note('Privat/Reise.md'), groups)).toBeNull();
    expect(colorFor(note('Privat/Reise.md'), [{ query: '  ', color: '#123456' }])).toBeNull();
  });

  it('works for unresolved nodes (by name) and tag nodes (by tag)', () => {
    expect(colorFor(unresolved('Fehlt'), [{ query: 'fehlt', color: '#111111' }])).toBe('#111111');
    expect(colorFor(tag('infra'), [{ query: 'tag:infra', color: '#222222' }])).toBe('#222222');
  });
});

describe('localGraph', () => {
  const chain: GraphData = {
    nodes: [note('A.md'), note('B.md', 2), note('C.md', 2), note('D.md'), note('X.md', 0)],
    links: [link('A.md', 'B.md'), link('C.md', 'B.md'), link('C.md', 'D.md')],
  };

  it('depth 1 = center + direct neighbours in both directions', () => {
    expect(ids(localGraph(chain, 'B.md', 1))).toEqual(['A.md', 'B.md', 'C.md']);
    expect(ids(localGraph(chain, 'C.md', 1))).toEqual(['B.md', 'C.md', 'D.md']);
    expect(linkIds(localGraph(chain, 'C.md', 1))).toEqual(['C.md->B.md', 'C.md->D.md']);
  });

  it('depth 2 reaches two hops; links between included nodes are kept', () => {
    const g = localGraph(chain, 'A.md', 2);
    expect(ids(g)).toEqual(['A.md', 'B.md', 'C.md']);
    expect(linkIds(g)).toEqual(['A.md->B.md', 'C.md->B.md']);
    expect(ids(localGraph(chain, 'A.md', 3))).toEqual(['A.md', 'B.md', 'C.md', 'D.md']);
  });

  it('a center without links is shown alone; an unknown center gives an empty graph', () => {
    expect(ids(localGraph(chain, 'X.md', 2))).toEqual(['X.md']);
    expect(localGraph(chain, 'Nope.md', 1)).toEqual({ nodes: [], links: [] });
  });
});

describe('helpers', () => {
  it('adjacency lists neighbours in both directions', () => {
    const adj = adjacency([link('A', 'B'), link('C', 'B')]);
    expect([...adj.get('B')!].sort()).toEqual(['A', 'C']);
    expect([...adj.get('A')!]).toEqual(['B']);
  });

  it('nodeRadius grows with sqrt(degree) and scales with nodeSize', () => {
    expect(nodeRadius(4, 1) - nodeRadius(0, 1)).toBeCloseTo(2 * (nodeRadius(1, 1) - nodeRadius(0, 1)));
    expect(nodeRadius(9, 2)).toBeCloseTo(2 * nodeRadius(9, 1));
  });

  it('withPositions copies nodes and carries x/y/z over by id', () => {
    const nodes = [note('A.md'), note('B.md')];
    const live = [{ id: 'A.md', x: 1, y: 2, z: 3, vx: 9 }];
    const out = withPositions(nodes, live);
    expect(out[0]).not.toBe(nodes[0]);
    expect(out[0]).toMatchObject({ id: 'A.md', x: 1, y: 2, z: 3 });
    expect(out[0]).not.toHaveProperty('vx');
    expect(out[1]).not.toHaveProperty('x');
    expect(nodes[0]).not.toHaveProperty('x');
  });
});

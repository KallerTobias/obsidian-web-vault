/** Pure graph helpers: filtering, colour groups, local graph, layout carry-over. */
import { fold, foldMeta, matchesFolded, parseQuery, type FoldedMeta } from '@shared/query';
import type { GraphData, Settings } from '../api';

export type GraphNode = GraphData['nodes'][number];
export type GraphLink = GraphData['links'][number];
export type GraphSettings = Settings['graph'];
export type GraphGroup = GraphSettings['groups'][number];

/** Layout coordinates the graph libraries add to node objects. */
export interface Position {
  id: string;
  x?: number;
  y?: number;
  z?: number;
}

type Matcher = (meta: FoldedMeta) => boolean;

/** What a query term is matched against: notes/attachments by path, unresolved links by their (future) name. */
function metaOf(n: GraphNode): FoldedMeta {
  switch (n.kind) {
    case 'unresolved':
      return foldMeta({ path: n.name, name: n.name, tags: [] });
    case 'tag':
      return foldMeta({ path: '', name: n.name, tags: [n.name.replace(/^#/, '')] });
    default:
      return foldMeta({ path: n.id, name: n.name, tags: n.tags });
  }
}

/** Parsed and folded once (5,000 nodes are matched per change); null for an empty query. */
function compile(query: string): Matcher | null {
  const terms = parseQuery(query).map((t) => ({ t, v: fold(t.value) }));
  if (terms.length === 0) return null;
  return (meta) => terms.every(({ t, v }) => matchesFolded(t, v, meta));
}

const compiled = new Map<string, Matcher | null>();
function matcher(query: string): Matcher | null {
  let m = compiled.get(query);
  if (m === undefined) {
    if (compiled.size > 200) compiled.clear();
    m = compile(query);
    compiled.set(query, m);
  }
  return m;
}

/** Id of a link end (a string, or the node object the graph libraries put in its place). */
export const endId = (end: unknown): string =>
  typeof end === 'object' && end !== null ? String((end as { id: unknown }).id) : String(end);

/** Neighbour ids per node id, in both directions. Accepts links whose ends the libraries replaced by node objects. */
export function adjacency(links: readonly { source: unknown; target: unknown }[]): Map<string, Set<string>> {
  const adj = new Map<string, Set<string>>();
  const add = (a: string, b: string) => {
    const set = adj.get(a);
    if (set) set.add(b);
    else adj.set(a, new Set([b]));
  };
  for (const l of links) {
    const s = endId(l.source);
    const t = endId(l.target);
    add(s, t);
    add(t, s);
  }
  return adj;
}

/**
 * The graph as the settings show it. Notes, attachments and unresolved links must match the
 * filter themselves; tag nodes are shown for the tags of shown notes. Orphans are nodes without
 * a visible link. Nodes are the input objects; links are fresh `{ source, target }` objects.
 */
export function filterGraph(data: GraphData, s: GraphSettings): GraphData {
  const match = matcher(s.filter);
  const kept = new Set<string>();
  for (const n of data.nodes) {
    if (n.kind === 'tag') continue;
    if (n.kind === 'attachment' && !s.showAttachments) continue;
    if (match && !match(metaOf(n))) continue;
    kept.add(n.id);
  }
  if (s.showTags) {
    for (const l of data.links) {
      if (l.target.startsWith('tag:') && kept.has(l.source)) kept.add(l.target);
    }
  }
  const links: GraphLink[] = [];
  const linked = new Set<string>();
  for (const l of data.links) {
    if (!kept.has(l.source) || !kept.has(l.target)) continue;
    links.push({ source: l.source, target: l.target });
    linked.add(l.source);
    linked.add(l.target);
  }
  const nodes = data.nodes.filter((n) => kept.has(n.id) && (s.showOrphans || linked.has(n.id)));
  return { nodes, links };
}

/** Colour of the first group whose query matches the node; null when none does. */
export function colorFor(node: GraphNode, groups: readonly GraphGroup[]): string | null {
  if (groups.length === 0) return null;
  const meta = metaOf(node);
  for (const g of groups) {
    const m = matcher(g.query);
    if (m && m(meta)) return g.color;
  }
  return null;
}

/** `center` and every node within `depth` links of it (either direction), with the links among them. */
export function localGraph(data: GraphData, center: string, depth: number): GraphData {
  if (!data.nodes.some((n) => n.id === center)) return { nodes: [], links: [] };
  const adj = adjacency(data.links);
  const seen = new Set([center]);
  let frontier = [center];
  for (let d = 0; d < depth && frontier.length > 0; d++) {
    const next: string[] = [];
    for (const id of frontier)
      for (const n of adj.get(id) ?? [])
        if (!seen.has(n)) {
          seen.add(n);
          next.push(n);
        }
    frontier = next;
  }
  return {
    nodes: data.nodes.filter((n) => seen.has(n.id)),
    links: data.links.filter((l) => seen.has(l.source) && seen.has(l.target)).map((l) => ({ source: l.source, target: l.target })),
  };
}

/** Node radius in graph units: grows with sqrt(degree), scaled by the node size setting. */
export function nodeRadius(degree: number, nodeSize: number): number {
  return (3 + 1.5 * Math.sqrt(degree)) * nodeSize;
}

/**
 * Copies of `nodes` (the libraries mutate what they get) with the coordinates of the same ids in
 * `previous`, so a reload or a 2D/3D switch keeps the layout. Velocities are not carried over.
 */
export function withPositions<N extends { id: string }>(nodes: readonly N[], previous: Iterable<Position>): (N & Omit<Position, 'id'>)[] {
  const pos = new Map<string, Position>();
  for (const p of previous) pos.set(p.id, p);
  return nodes.map((n) => {
    const p = pos.get(n.id);
    if (!p) return { ...n };
    const out: N & Omit<Position, 'id'> = { ...n };
    if (p.x !== undefined) out.x = p.x;
    if (p.y !== undefined) out.y = p.y;
    if (p.z !== undefined) out.z = p.z;
    return out;
  });
}

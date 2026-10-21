/// <reference lib="dom" />
/// <reference types="svelte" />
import { cleanup, render } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GraphData } from '../../../web/src/lib/api';
import GraphCanvas from '../../../web/src/lib/graph/GraphCanvas.svelte';
import { DEFAULT_GRAPH_SETTINGS } from '../../../web/src/lib/stores/graph';

/* The graph libraries need canvas/WebGL, which jsdom lacks: both are replaced by recording doubles. */
const fakes = vi.hoisted(() => {
  type Fn = (...args: unknown[]) => unknown;
  interface Fake {
    kind: '2d' | '3d';
    el: HTMLElement;
    calls: Map<string, unknown[][]>;
    last(name: string): unknown[] | undefined;
    fn(name: string): Fn;
    data: { nodes: Record<string, unknown>[]; links: unknown[] };
    charge: { strength: Fn };
    link: { distance: Fn };
    [method: string]: unknown;
  }
  const list: Fake[] = [];
  const common = ['width', 'height', 'nodeId', 'nodeLabel', 'linkColor', 'onNodeClick', 'onNodeHover', 'onEngineStop', 'zoomToFit', 'd3ReheatSimulation', 'pauseAnimation', '_destructor'];
  const only2d = ['nodeCanvasObject', 'nodeCanvasObjectMode', 'nodePointerAreaPaint'];
  const only3d = ['backgroundColor', 'nodeColor', 'nodeVal', 'nodeRelSize', 'nodeResolution', 'linkOpacity', 'showNavInfo'];
  function create(kind: '2d' | '3d', el: HTMLElement): Fake {
    const calls = new Map<string, unknown[][]>();
    const record = (name: string, args: unknown[]) => {
      const l = calls.get(name) ?? [];
      l.push(args);
      calls.set(name, l);
    };
    const fake = {
      kind,
      el,
      calls,
      data: { nodes: [], links: [] },
      charge: { strength: () => undefined },
      link: { distance: () => undefined },
      last: (name: string) => calls.get(name)?.at(-1),
      fn: (name: string) => calls.get(name)!.at(-1)![0] as Fn,
    } as unknown as Fake;
    fake.charge.strength = (v) => (record('charge', [v]), fake.charge);
    fake.link.distance = (v) => (record('distance', [v]), fake.link);
    for (const name of [...common, ...(kind === '2d' ? only2d : only3d)])
      fake[name] = (...args: unknown[]) => {
        record(name, args);
        return fake;
      };
    fake.graphData = (...args: unknown[]) => {
      if (args.length === 0) return fake.data;
      record('graphData', args);
      fake.data = args[0] as Fake['data'];
      return fake;
    };
    fake.d3Force = (...args: unknown[]) => {
      if (args.length === 1) return args[0] === 'charge' ? fake.charge : args[0] === 'link' ? fake.link : undefined;
      record('d3Force', args);
      return fake;
    };
    list.push(fake);
    return fake;
  }
  return { list, create };
});

vi.mock('force-graph', () => ({
  default: vi.fn(function (el: HTMLElement) {
    return fakes.create('2d', el);
  }),
}));
vi.mock('3d-force-graph', () => ({
  default: vi.fn(function (el: HTMLElement) {
    return fakes.create('3d', el);
  }),
}));

const observers: { observe: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }[] = [];
beforeEach(() => {
  fakes.list.length = 0;
  observers.length = 0;
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe = vi.fn();
      unobserve = vi.fn();
      disconnect = vi.fn();
      constructor() {
        observers.push(this);
      }
    },
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const node = (id: string, kind: GraphData['nodes'][number]['kind'] = 'note', name = id.replace(/\.md$/, '')) => ({
  id,
  name,
  kind,
  tags: [],
  folder: '',
  degree: 1,
});
const data: GraphData = {
  nodes: [node('A.md'), node('B.md'), node('C.md'), node('tag:#x', 'tag', '#x'), node('unresolved:Neu', 'unresolved', 'Neu')],
  links: [
    { source: 'A.md', target: 'B.md' },
    { source: 'B.md', target: 'C.md' },
  ],
};
const settings = DEFAULT_GRAPH_SETTINGS;

async function mounted(count = 1) {
  await vi.waitFor(() => expect(fakes.list.length).toBe(count));
  await vi.waitFor(() => expect(fakes.list[count - 1]!.calls.has('graphData')).toBe(true));
  return fakes.list[count - 1]!;
}

describe('GraphCanvas', () => {
  it('2D: renders the data as copies with string link ends; 3d-force-graph is not loaded', async () => {
    const ThreeD = (await import('3d-force-graph')).default;
    render(GraphCanvas, { data, settings, mode: '2d' });
    const g = await mounted();
    expect(g.kind).toBe('2d');
    expect(g.el.getAttribute('aria-label')).toBe('Graph');
    expect(g.data.nodes.map((n) => n.id)).toEqual(data.nodes.map((n) => n.id));
    expect(g.data.nodes[0]).not.toBe(data.nodes[0]);
    expect(g.data.links[0]).toEqual({ source: 'A.md', target: 'B.md' });
    expect(g.data.links[0]).not.toBe(data.links[0]);
    expect(ThreeD).not.toHaveBeenCalled();
  });

  it('never hands note names to the library tooltip as HTML', async () => {
    render(GraphCanvas, { data, settings, mode: '2d' });
    const g = await mounted();
    expect(g.fn('nodeLabel')({ ...node('x.md'), name: '<img src=x onerror=alert(1)>' })).toBe('');
  });

  it('clicks: notes open (Ctrl = new tab), tags search, unresolved links create', async () => {
    const onOpen = vi.fn();
    const onTag = vi.fn();
    const onUnresolved = vi.fn();
    render(GraphCanvas, { data, settings, onOpen, onTag, onUnresolved });
    const g = await mounted();
    const click = g.fn('onNodeClick');
    click(g.data.nodes[0], { ctrlKey: true, metaKey: false });
    click(g.data.nodes[1], { ctrlKey: false, metaKey: false });
    click(g.data.nodes[3], { ctrlKey: false, metaKey: false });
    click(g.data.nodes[4], { ctrlKey: false, metaKey: true });
    expect(onOpen.mock.calls).toEqual([
      ['A.md', true],
      ['B.md', false],
    ]);
    expect(onTag).toHaveBeenCalledWith('x');
    expect(onUnresolved).toHaveBeenCalledWith('Neu', true);
  });

  it('new data keeps the positions of nodes that stay', async () => {
    const { rerender } = render(GraphCanvas, { data, settings });
    const g = await mounted();
    Object.assign(g.data.nodes[0]!, { x: 5, y: 6 });
    await rerender({ data: { nodes: [node('A.md'), node('D.md')], links: [] } });
    expect(g.data.nodes).toHaveLength(2);
    expect(g.data.nodes[0]).toMatchObject({ id: 'A.md', x: 5, y: 6 });
    expect(g.data.nodes[1]).not.toHaveProperty('x');
  });

  it('switching to 3D destroys the 2D renderer and keeps the layout', async () => {
    const { rerender } = render(GraphCanvas, { data, settings, mode: '2d' });
    const g2 = await mounted();
    Object.assign(g2.data.nodes[1]!, { x: -3, y: 4 });
    await rerender({ mode: '3d' });
    const g3 = await mounted(2);
    expect(g2.calls.has('pauseAnimation')).toBe(true);
    expect(g2.calls.has('_destructor')).toBe(true);
    expect(g3.kind).toBe('3d');
    expect(g3.data.nodes[1]).toMatchObject({ id: 'B.md', x: -3, y: 4 });
    // 3D tooltips get text nodes, not HTML.
    const label = g3.fn('nodeLabel')({ ...node('x.md'), name: '<b>x</b>' }) as HTMLElement;
    expect(label.textContent).toBe('<b>x</b>');
    expect(label.children).toHaveLength(0);
  });

  it('unmounting stops the animation, destroys the renderer and the resize observer', async () => {
    const { unmount } = render(GraphCanvas, { data, settings });
    const g = await mounted();
    expect(observers[0]!.observe).toHaveBeenCalled();
    unmount();
    expect(g.calls.has('pauseAnimation')).toBe(true);
    expect(g.calls.has('_destructor')).toBe(true);
    expect(observers[0]!.disconnect).toHaveBeenCalled();
  });

  it('applies the forces; colour changes restyle without restarting the simulation', async () => {
    const { rerender } = render(GraphCanvas, { data, settings: { ...settings, repel: 2, linkDistance: 0.5 } });
    const g = await mounted();
    expect(g.last('charge')).toEqual([-80]);
    expect(g.last('distance')).toEqual([15]);
    expect(g.calls.get('d3Force')!.some((c) => c[0] === 'gravity')).toBe(true);
    const reheats = g.calls.get('d3ReheatSimulation')!.length;
    const draws = g.calls.get('nodeCanvasObject')!.length;
    await rerender({ settings: { ...settings, repel: 2, linkDistance: 0.5, groups: [{ query: 'path:A', color: '#ff0000' }] } });
    expect(g.calls.get('d3ReheatSimulation')!.length).toBe(reheats);
    expect(g.calls.get('nodeCanvasObject')!.length).toBeGreaterThan(draws);
    await rerender({ settings: { ...settings, repel: 3 } });
    expect(g.last('charge')).toEqual([-120]);
    expect(g.calls.get('d3ReheatSimulation')!.length).toBe(reheats + 1);
  });

  it('hover highlights the node and its links; others are dimmed', async () => {
    render(GraphCanvas, { data, settings });
    const g = await mounted();
    const before = g.fn('linkColor');
    const plain = before({ source: 'A.md', target: 'B.md' });
    g.fn('onNodeHover')(g.data.nodes[0]);
    const color = g.fn('linkColor');
    const touching = color({ source: { id: 'A.md' }, target: { id: 'B.md' } });
    const other = color({ source: { id: 'B.md' }, target: { id: 'C.md' } });
    expect(touching).not.toBe(plain);
    expect(other).not.toBe(plain);
    expect(touching).not.toBe(other);
    g.fn('onNodeHover')(null);
    expect(g.fn('linkColor')({ source: 'B.md', target: 'C.md' })).toBe(plain);
  });

  it('shows a message when the renderer cannot be created (no WebGL)', async () => {
    const ThreeD = (await import('3d-force-graph')).default as unknown as ReturnType<typeof vi.fn>;
    ThreeD.mockImplementationOnce(function () {
      throw new Error('Error creating WebGL context.');
    });
    const { findByRole } = render(GraphCanvas, { data, settings, mode: '3d' });
    expect((await findByRole('alert')).textContent).toMatch(/nicht dargestellt/);
  });
});

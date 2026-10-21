/// <reference lib="dom" />
/// <reference types="svelte" />
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GraphData } from '../../../web/src/lib/api';
import GraphView from '../../../web/src/lib/graph/GraphView.svelte';
import { DEFAULT_GRAPH_SETTINGS, graphSettings } from '../../../web/src/lib/stores/graph';

/* Minimal chainable doubles for both graph libraries (GraphCanvas.test covers the renderer wiring). */
const fakes = vi.hoisted(() => {
  const list: { kind: string; data: { nodes: { id: string }[]; links: unknown[] }; setData: number }[] = [];
  function create(kind: string) {
    const rec = { kind, data: { nodes: [] as { id: string }[], links: [] as unknown[] }, setData: 0 };
    list.push(rec);
    const self: object = new Proxy(
      {},
      {
        get: (_, prop) => {
          if (prop === 'graphData')
            return (...args: unknown[]) => {
              if (!args.length) return rec.data;
              rec.data = args[0] as typeof rec.data;
              rec.setData++;
              return self;
            };
          if (prop === 'd3Force') return (...args: unknown[]) => (args.length === 1 ? undefined : self);
          return () => self;
        },
      },
    );
    return self;
  }
  return { list, create };
});
vi.mock('force-graph', () => ({ default: vi.fn(function () {
    return fakes.create('2d');
  }) }));
vi.mock('3d-force-graph', () => ({ default: vi.fn(function () {
    return fakes.create('3d');
  }) }));

const graph: GraphData = {
  nodes: [
    { id: 'Homelab/Server.md', name: 'Server', kind: 'note', tags: ['infra'], folder: 'Homelab', degree: 2 },
    { id: 'Privat/Reise.md', name: 'Reise', kind: 'note', tags: [], folder: 'Privat', degree: 1 },
    { id: 'tag:#infra', name: '#infra', kind: 'tag', tags: [], folder: '', degree: 1 },
  ],
  links: [
    { source: 'Homelab/Server.md', target: 'Privat/Reise.md' },
    { source: 'Homelab/Server.md', target: 'tag:#infra' },
  ],
};

let puts: unknown[] = [];
beforeEach(() => {
  fakes.list.length = 0;
  puts = [];
  localStorage.clear();
  graphSettings.update({ ...DEFAULT_GRAPH_SETTINGS });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/graph') return Response.json(graph);
      if (url === '/api/settings' && init?.method === 'PUT') {
        puts.push(JSON.parse(String(init.body)));
        return Response.json({});
      }
      if (url === '/api/settings') return Response.json({ graph: { ...DEFAULT_GRAPH_SETTINGS, showTags: true } });
      return new Response(null, { status: 404 });
    }),
  );
  graphSettings.flush(); // the reset above, before counting PUTs
  puts = [];
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const ids = () => fakes.list.at(-1)!.data.nodes.map((n) => n.id).sort();

describe('GraphView', () => {
  it('loads graph and settings and shows the filtered graph', async () => {
    render(GraphView);
    await vi.waitFor(() => expect(ids()).toEqual(['Homelab/Server.md', 'Privat/Reise.md', 'tag:#infra']));
    expect(fakes.list.at(-1)!.kind).toBe('2d');
    expect(screen.getByRole('button', { name: '2D' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('filter and switches refilter; the change is saved after 500 ms', async () => {
    render(GraphView);
    await vi.waitFor(() => expect(ids()).toHaveLength(3));
    await fireEvent.input(screen.getByLabelText('Filter'), { target: { value: 'path:Homelab' } });
    expect(ids()).toEqual(['Homelab/Server.md', 'tag:#infra']);
    await fireEvent.click(screen.getByLabelText('Tags'));
    expect(ids()).toEqual(['Homelab/Server.md']);
    expect(puts).toHaveLength(0);
    await vi.waitFor(() => expect(puts).toHaveLength(1), { timeout: 2000 });
    expect(puts[0]).toEqual({ graph: expect.objectContaining({ filter: 'path:Homelab', showTags: false }) });
  });

  it('sliders change forces without resetting the data', async () => {
    render(GraphView);
    await vi.waitFor(() => expect(ids()).toHaveLength(3));
    const before = fakes.list.at(-1)!.setData;
    await fireEvent.input(screen.getByLabelText(/Abstoßung/), { target: { value: '2' } });
    expect(fakes.list.at(-1)!.setData).toBe(before);
  });

  it('switches to 3D (lazy library), keeping the filter', async () => {
    render(GraphView);
    await vi.waitFor(() => expect(ids()).toHaveLength(3));
    await fireEvent.input(screen.getByLabelText('Filter'), { target: { value: 'reise' } });
    await fireEvent.click(screen.getByRole('button', { name: '3D' }));
    await vi.waitFor(() => expect(fakes.list.at(-1)!.kind).toBe('3d'));
    await vi.waitFor(() => expect(ids()).toEqual(['Privat/Reise.md']));
    expect(screen.getByRole('button', { name: '3D' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('groups: add, edit query and colour, reorder, remove', async () => {
    render(GraphView);
    await fireEvent.click(screen.getByRole('button', { name: 'Neue Gruppe' }));
    await fireEvent.click(screen.getByRole('button', { name: 'Neue Gruppe' }));
    await fireEvent.input(screen.getByLabelText('Suchausdruck von Gruppe 1'), { target: { value: 'path:Homelab' } });
    await fireEvent.input(screen.getByLabelText('Farbe von Gruppe 2'), { target: { value: '#123456' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Gruppe 2 nach oben' }));
    let groups: { query: string; color: string }[] = [];
    graphSettings.subscribe((s) => (groups = s.groups))();
    expect(groups).toEqual([
      { query: '', color: '#123456' },
      { query: 'path:Homelab', color: '#e03131' },
    ]);
    await fireEvent.click(screen.getByRole('button', { name: 'Gruppe 1 entfernen' }));
    graphSettings.subscribe((s) => (groups = s.groups))();
    expect(groups).toEqual([{ query: 'path:Homelab', color: '#e03131' }]);
  });

  it('the settings sidebar collapses, remembered', async () => {
    render(GraphView);
    const toggle = screen.getByRole('button', { name: 'Graph-Einstellungen ein-/ausblenden' });
    expect(screen.getByRole('complementary', { name: 'Graph-Einstellungen' })).toBeTruthy();
    await fireEvent.click(toggle);
    expect(screen.queryByRole('complementary', { name: 'Graph-Einstellungen' })).toBeNull();
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    cleanup();
    render(GraphView);
    expect(screen.queryByRole('complementary', { name: 'Graph-Einstellungen' })).toBeNull();
  });

  it('saves a waiting change when the tab closes', async () => {
    const { unmount } = render(GraphView);
    await fireEvent.input(screen.getByLabelText('Filter'), { target: { value: 'x' } });
    unmount();
    expect(puts).toEqual([{ graph: expect.objectContaining({ filter: 'x' }) }]);
  });
});

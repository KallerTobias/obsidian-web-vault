import { get } from 'svelte/store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GraphData, Settings, VaultEvent } from '../../web/src/lib/api';
import { createGraphSettings, DEFAULT_GRAPH_SETTINGS, watchGraph } from '../../web/src/lib/stores/graph';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const settingsWith = (graph: Partial<Settings['graph']>) => ({ graph }) as unknown as Settings;

describe('graph settings store', () => {
  it('loads the saved settings over the defaults', async () => {
    const s = createGraphSettings({ get: async () => settingsWith({ localDepth: 3 }), save: vi.fn() });
    expect(get(s)).toEqual(DEFAULT_GRAPH_SETTINGS);
    await s.load();
    expect(get(s)).toEqual({ ...DEFAULT_GRAPH_SETTINGS, localDepth: 3 });
  });

  it('applies changes at once and saves them debounced (500 ms after the last one)', async () => {
    const save = vi.fn(async () => undefined);
    const s = createGraphSettings({ get: async () => settingsWith({}), save });
    s.update({ repel: 1.5 });
    expect(get(s).repel).toBe(1.5);
    await vi.advanceTimersByTimeAsync(400);
    s.update({ filter: 'path:Homelab' });
    await vi.advanceTimersByTimeAsync(400);
    expect(save).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith({ ...DEFAULT_GRAPH_SETTINGS, repel: 1.5, filter: 'path:Homelab' });
  });

  it('a load does not undo a change that is still waiting to be saved; flush saves at once', async () => {
    const save = vi.fn(async () => undefined);
    const s = createGraphSettings({ get: async () => settingsWith({ repel: 3 }), save });
    s.update({ repel: 2 });
    await s.load();
    expect(get(s).repel).toBe(2);
    s.flush();
    expect(save).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(save).toHaveBeenCalledTimes(1);
  });
});

describe('watchGraph', () => {
  const graph = (n: number): GraphData => ({ nodes: [], links: Array.from({ length: n }, () => ({ source: 'a', target: 'b' })) });

  function setup() {
    let listener: ((e?: VaultEvent) => void) | undefined;
    let calls = 0;
    const deps = {
      load: vi.fn(async () => graph(++calls)),
      onAnyChange: vi.fn((fn: (e?: VaultEvent) => void) => {
        listener = fn;
        return () => (listener = undefined);
      }),
    };
    const onData = vi.fn();
    const stop = watchGraph(onData, vi.fn(), deps);
    return { deps, onData, stop, emit: (e?: VaultEvent) => listener?.(e), listening: () => listener !== undefined };
  }

  it('loads at once, then 2 s after the last created/deleted/renamed event or resync', async () => {
    const { deps, onData, emit } = setup();
    await vi.advanceTimersByTimeAsync(0);
    expect(onData).toHaveBeenCalledTimes(1);
    emit({ type: 'created', path: 'A.md', seq: 1 } as VaultEvent);
    await vi.advanceTimersByTimeAsync(1500);
    emit({ type: 'renamed', from: 'A.md', to: 'B.md', seq: 2 } as VaultEvent);
    await vi.advanceTimersByTimeAsync(1999);
    expect(deps.load).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(deps.load).toHaveBeenCalledTimes(2);
    emit(); // resync
    await vi.advanceTimersByTimeAsync(2000);
    expect(deps.load).toHaveBeenCalledTimes(3);
    expect(onData).toHaveBeenLastCalledWith(graph(3));
  });

  it('ignores changed events (saving a note)', async () => {
    const { deps, emit } = setup();
    emit({ type: 'changed', path: 'A.md', seq: 1 } as VaultEvent);
    await vi.advanceTimersByTimeAsync(5000);
    expect(deps.load).toHaveBeenCalledTimes(1);
  });

  it('stop unsubscribes and cancels a pending reload', async () => {
    const { deps, onData, stop, emit, listening } = setup();
    emit({ type: 'deleted', path: 'A.md', seq: 1 } as VaultEvent);
    stop();
    expect(listening()).toBe(false);
    await vi.advanceTimersByTimeAsync(5000);
    expect(deps.load).toHaveBeenCalledTimes(1);
    expect(onData).not.toHaveBeenCalled(); // the first answer arrived after stop
  });
});

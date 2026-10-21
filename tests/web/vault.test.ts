import { get } from 'svelte/store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LookupEntry, TreeEntry } from '../../web/src/lib/api';
import { createVault, type VaultStore } from '../../web/src/lib/stores/vault';

const root = (n: number): TreeEntry => ({ path: '', name: '', kind: 'folder', mtime: n, size: 0, readonly: false, children: [] });

let tree: ReturnType<typeof vi.fn<() => Promise<TreeEntry>>>;
let lookup: ReturnType<typeof vi.fn<() => Promise<LookupEntry[]>>>;
let v: VaultStore;

beforeEach(() => {
  vi.useFakeTimers();
  let n = 0;
  tree = vi.fn(async () => root(++n));
  lookup = vi.fn(async () => []);
  v = createVault({ tree, lookup });
});
afterEach(() => {
  v.dispose();
  vi.useRealTimers();
});

describe('vault store', () => {
  it('load() fetches tree and lookup', async () => {
    await v.load();
    expect(get(v.tree)?.mtime).toBe(1);
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it('a burst of structure events reloads tree and lookup once', async () => {
    v.applyEvent({ seq: 1, type: 'created', path: 'A.md' });
    v.applyEvent({ seq: 2, type: 'renamed', from: 'A.md', to: 'B.md' });
    v.applyEvent({ seq: 3, type: 'deleted', path: 'C' });
    await vi.advanceTimersByTimeAsync(300);
    expect(tree).toHaveBeenCalledTimes(1);
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it('a content change reloads only the lookup, later', async () => {
    v.applyEvent({ seq: 1, type: 'changed', path: 'A.md' });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(lookup).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_100);
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(tree).not.toHaveBeenCalled();
  });

  it('a structure change brings a pending lazy lookup reload forward', async () => {
    v.applyEvent({ seq: 1, type: 'changed', path: 'A.md' });
    v.applyEvent({ seq: 2, type: 'created', path: 'B.md' });
    await vi.advanceTimersByTimeAsync(300);
    expect(lookup).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(lookup).toHaveBeenCalledTimes(1);
  });
});

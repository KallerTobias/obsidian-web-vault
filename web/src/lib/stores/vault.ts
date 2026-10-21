import { writable, type Readable } from 'svelte/store';
import { api, type LookupEntry, type TreeEntry, type VaultEvent } from '../api';

export interface VaultStore {
  /** The vault root (path '') with all visible entries; null until loaded. */
  tree: Readable<TreeEntry | null>;
  /** Every note and file with name, aliases and headings (for links and the quick switcher). */
  lookup: Readable<LookupEntry[]>;
  /** Loads tree and lookup now. */
  load(): Promise<void>;
  /** Reloads what an event changed (debounced: a folder move or a burst of saves loads once). */
  applyEvent(e: VaultEvent): void;
  /** Stops pending reloads. */
  dispose(): void;
}

export interface VaultDeps {
  tree: () => Promise<TreeEntry>;
  lookup: () => Promise<LookupEntry[]>;
}

/** Structure changes show quickly in the tree … */
const TREE_DELAY_MS = 250;
/** … content changes (every save) touch only headings/aliases: reload the lookup more lazily. */
const LOOKUP_DELAY_MS = 2_000;

export function createVault(deps: VaultDeps = { tree: api.tree, lookup: api.lookup }): VaultStore {
  const tree = writable<TreeEntry | null>(null);
  const lookup = writable<LookupEntry[]>([]);
  const timers: Partial<Record<'tree' | 'lookup', { id: ReturnType<typeof setTimeout>; due: number }>> = {};
  /** Answers of older requests must not overwrite newer ones. */
  const generation = { tree: 0, lookup: 0 };

  async function loadTree(): Promise<void> {
    const g = ++generation.tree;
    const t = await deps.tree();
    if (g === generation.tree) tree.set(t);
  }

  async function loadLookup(): Promise<void> {
    const g = ++generation.lookup;
    const l = await deps.lookup();
    if (g === generation.lookup) lookup.set(l);
  }

  function schedule(what: 'tree' | 'lookup', delay: number): void {
    const due = Date.now() + delay;
    const pending = timers[what];
    if (pending) {
      if (pending.due <= due) return;
      clearTimeout(pending.id); // a structure change needs it sooner than the pending content reload
    }
    const id = setTimeout(() => {
      timers[what] = undefined;
      (what === 'tree' ? loadTree : loadLookup)().catch(() => {
        /* offline: the next event or resync loads again */
      });
    }, delay);
    timers[what] = { id, due };
  }

  return {
    tree: { subscribe: tree.subscribe },
    lookup: { subscribe: lookup.subscribe },
    async load() {
      await Promise.all([loadTree(), loadLookup()]);
    },
    applyEvent(e) {
      if (e.type !== 'changed') schedule('tree', TREE_DELAY_MS);
      schedule('lookup', e.type === 'changed' ? LOOKUP_DELAY_MS : TREE_DELAY_MS);
    },
    dispose() {
      clearTimeout(timers.tree?.id);
      clearTimeout(timers.lookup?.id);
      timers.tree = timers.lookup = undefined;
    },
  };
}

/** The app's vault data. */
export const vault = createVault();

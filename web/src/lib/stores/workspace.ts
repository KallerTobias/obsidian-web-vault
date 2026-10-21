import { writable, type Readable } from 'svelte/store';
import type { VaultEvent } from '../api';
import { isAtOrBelow, isNotePath, movePath } from '../tree';

export type TabKind = 'note' | 'file' | 'graph' | 'settings';

/**
 * One tab. Note/file tabs navigate like a browser tab: `history` holds vault paths, `pos` the
 * current one and `path` mirrors `history[pos]`. Graph and settings tabs have no history (`pos` -1).
 */
export interface Tab {
  kind: TabKind;
  path?: string;
  history: string[];
  pos: number;
  /** Heading or block (`#…`, `#^…`) to scroll to; only for the current entry. */
  subpath?: string;
  /** 0-based line to scroll to; a new object on every open, so opening the same line again scrolls again. */
  reveal?: { line: number };
  /** The current file was deleted (or moved away) outside of this tab. */
  deleted?: boolean;
}

export interface WorkspaceState {
  tabs: Tab[];
  /** Index of the active tab; -1 without tabs. */
  active: number;
  /** Recently opened paths, newest first. */
  recent: string[];
}

export interface OpenOptions {
  newTab?: boolean;
  subpath?: string;
  /** 0-based line of the note to scroll to (e.g. a backlink's context line). */
  line?: number;
}

export interface Workspace extends Readable<WorkspaceState> {
  open(path: string, opts?: OpenOptions): void;
  openGraph(): void;
  openSettings(): void;
  activate(i: number): void;
  close(i: number): void;
  back(): void;
  forward(): void;
  /** Keeps tabs and history in step with renames/deletions in the vault. */
  applyEvent(e: VaultEvent): void;
}

const KEY = 'vw.workspace';
export const RECENT_MAX = 20;
/** History entries kept per tab (oldest dropped). */
const HISTORY_MAX = 100;

const kindOf = (path: string): TabKind => (isNotePath(path) ? 'note' : 'file');

function withCurrent(tab: Tab): Tab {
  const path = tab.history[tab.pos];
  if (path === undefined) return tab;
  return { ...tab, path, kind: kindOf(path) };
}

const isString = (v: unknown): v is string => typeof v === 'string';

function validTab(v: unknown): v is Tab {
  if (typeof v !== 'object' || v === null) return false;
  const t = v as Partial<Tab>;
  if (t.kind === 'graph' || t.kind === 'settings') return Array.isArray(t.history) && t.history.length === 0;
  return (
    (t.kind === 'note' || t.kind === 'file') &&
    Array.isArray(t.history) &&
    t.history.length > 0 &&
    t.history.every(isString) &&
    Number.isInteger(t.pos) &&
    (t.pos as number) >= 0 &&
    (t.pos as number) < t.history.length
  );
}

function load(storage: Storage | null): WorkspaceState {
  const empty: WorkspaceState = { tabs: [], active: -1, recent: [] };
  let raw: string | null = null;
  try {
    raw = storage?.getItem(KEY) ?? null;
  } catch {
    return empty;
  }
  if (!raw) return empty;
  try {
    const data = JSON.parse(raw) as Partial<WorkspaceState>;
    const tabs = (Array.isArray(data.tabs) ? data.tabs.filter(validTab) : []).map((t) =>
      t.kind === 'graph' || t.kind === 'settings'
        ? { kind: t.kind, history: [], pos: -1 }
        : withCurrent({ kind: t.kind, history: t.history, pos: t.pos }),
    );
    const active = Number.isInteger(data.active) && (data.active as number) >= 0 && (data.active as number) < tabs.length
      ? (data.active as number)
      : tabs.length - 1;
    const recent = Array.isArray(data.recent) ? data.recent.filter(isString).slice(0, RECENT_MAX) : [];
    return { tabs, active, recent };
  } catch {
    return empty;
  }
}

function defaultStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** Tabs, per-tab history and recent files; saved in localStorage (`storage` is injectable for tests). */
export function createWorkspace(storage: Storage | null = defaultStorage()): Workspace {
  const store = writable<WorkspaceState>(load(storage));
  let state: WorkspaceState;
  store.subscribe((s) => (state = s));

  function commit(next: WorkspaceState): void {
    store.set(next);
    try {
      // Transient marks (subpath, reveal, deleted) are not persisted.
      const tabs = next.tabs.map(({ kind, history, pos }) => ({ kind, history, pos }));
      storage?.setItem(KEY, JSON.stringify({ tabs, active: next.active, recent: next.recent }));
    } catch {
      /* storage full or blocked: the workspace is just not remembered */
    }
  }

  const addRecent = (recent: string[], path: string) => [path, ...recent.filter((p) => p !== path)].slice(0, RECENT_MAX);

  function replaceTab(i: number, tab: Tab, extra: Partial<WorkspaceState> = {}): void {
    const tabs = state.tabs.slice();
    tabs[i] = tab;
    commit({ ...state, ...extra, tabs });
  }

  function open(path: string, opts: OpenOptions = {}): void {
    const recent = addRecent(state.recent, path);
    const current = state.tabs[state.active];
    const reveal = opts.line === undefined ? undefined : { line: opts.line };
    if (opts.newTab || !current) {
      const tab: Tab = withCurrent({ kind: kindOf(path), history: [path], pos: 0, subpath: opts.subpath, reveal });
      const at = current ? state.active + 1 : state.tabs.length;
      const tabs = state.tabs.slice();
      tabs.splice(at, 0, tab);
      commit({ tabs, active: at, recent });
      return;
    }
    if (current.history[current.pos] === path) {
      replaceTab(state.active, { ...current, subpath: opts.subpath, reveal, deleted: false }, { recent });
      return;
    }
    const history = [...current.history.slice(0, current.pos + 1), path].slice(-HISTORY_MAX);
    replaceTab(state.active, withCurrent({ kind: current.kind, history, pos: history.length - 1, subpath: opts.subpath, reveal }), {
      recent,
    });
  }

  function openSpecial(kind: 'graph' | 'settings'): void {
    const existing = state.tabs.findIndex((t) => t.kind === kind);
    if (existing >= 0) {
      commit({ ...state, active: existing });
      return;
    }
    const tabs = [...state.tabs, { kind, history: [], pos: -1 }];
    commit({ ...state, tabs, active: tabs.length - 1 });
  }

  function step(delta: number): void {
    const tab = state.tabs[state.active];
    if (!tab) return;
    const pos = tab.pos + delta;
    if (pos < 0 || pos >= tab.history.length) return;
    replaceTab(state.active, withCurrent({ kind: tab.kind, history: tab.history, pos }));
  }

  function close(i: number): void {
    if (i < 0 || i >= state.tabs.length) return;
    const tabs = state.tabs.filter((_, j) => j !== i);
    let active = state.active;
    if (i < active || (i === active && active >= tabs.length)) active--;
    commit({ ...state, tabs, active: tabs.length ? Math.max(0, active) : -1 });
  }

  function applyEvent(e: VaultEvent): void {
    if (e.type === 'renamed') {
      const tabs = state.tabs.map((t) => {
        if (!t.history.some((p) => isAtOrBelow(p, e.from))) return t;
        const moved = withCurrent({ ...t, history: t.history.map((p) => movePath(p, e.from, e.to)) });
        return t.path !== undefined && isAtOrBelow(t.path, e.from) ? { ...moved, deleted: false } : moved;
      });
      const recent = [...new Set(state.recent.map((p) => movePath(p, e.from, e.to)))];
      commit({ ...state, tabs, recent });
    } else if (e.type === 'deleted' || e.type === 'created') {
      const deleted = e.type === 'deleted';
      if (!state.tabs.some((t) => t.path !== undefined && isAtOrBelow(t.path, e.path) && Boolean(t.deleted) !== deleted)) return;
      const tabs = state.tabs.map((t) =>
        t.path !== undefined && (deleted ? isAtOrBelow(t.path, e.path) : t.path === e.path) ? { ...t, deleted } : t,
      );
      commit({ ...state, tabs });
    }
  }

  return {
    subscribe: store.subscribe,
    open,
    openGraph: () => openSpecial('graph'),
    openSettings: () => openSpecial('settings'),
    activate: (i) => {
      if (i >= 0 && i < state.tabs.length && i !== state.active) commit({ ...state, active: i });
    },
    close,
    back: () => step(-1),
    forward: () => step(1),
    applyEvent,
  };
}

/** The app's workspace. */
export const workspace = createWorkspace();

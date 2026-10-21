import { writable, type Readable } from 'svelte/store';
import { api, type GraphData, type Settings, type VaultEvent } from '../api';
import { events } from './events';

export type GraphSettings = Settings['graph'];

/** Same as the server's defaults (`server/store/settings.ts`), used until the settings are loaded. */
export const DEFAULT_GRAPH_SETTINGS: GraphSettings = {
  mode: '2d',
  filter: '',
  showTags: false,
  showAttachments: false,
  showOrphans: true,
  groups: [],
  repel: 1,
  linkDistance: 1,
  center: 1,
  nodeSize: 1,
  localDepth: 1,
};

/** Changes are saved this long after the last one (sliders and typing produce many). */
export const SAVE_DELAY_MS = 500;
/** The graph is reloaded this long after the last structural change (a folder move is a burst). */
export const RELOAD_DELAY_MS = 2_000;

export interface GraphSettingsStore extends Readable<GraphSettings> {
  /** Loads the saved settings (kept as they are while a change is waiting to be saved). */
  load(): Promise<void>;
  /** Applies a change now and saves it after `SAVE_DELAY_MS`. */
  update(patch: Partial<GraphSettings>): void;
  /** Saves a waiting change right away; resolves when that save has settled (succeeded or failed). */
  flush(): Promise<void>;
}

export interface GraphSettingsDeps {
  get: () => Promise<Settings>;
  save: (graph: GraphSettings) => Promise<unknown>;
}

export function createGraphSettings(
  deps: GraphSettingsDeps = { get: api.settings.get, save: (graph) => api.settings.update({ graph }) },
): GraphSettingsStore {
  const store = writable<GraphSettings>({ ...DEFAULT_GRAPH_SETTINGS });
  let current = { ...DEFAULT_GRAPH_SETTINGS };
  store.subscribe((s) => (current = s));
  let timer: ReturnType<typeof setTimeout> | undefined;

  function save(): Promise<void> {
    clearTimeout(timer);
    timer = undefined;
    return deps.save(current).then(
      () => {},
      () => {
        /* offline or expired session (the API client reports that): the change stays for this session */
      },
    );
  }

  return {
    subscribe: store.subscribe,
    async load() {
      const s = await deps.get();
      if (timer === undefined) store.set({ ...DEFAULT_GRAPH_SETTINGS, ...s.graph });
    },
    update(patch) {
      store.set({ ...current, ...patch });
      clearTimeout(timer);
      timer = setTimeout(() => void save(), SAVE_DELAY_MS);
    },
    async flush() {
      if (timer !== undefined) await save();
    },
  };
}

/** The app's graph settings (graph tab and local graph). */
export const graphSettings = createGraphSettings();

export interface WatchGraphDeps {
  load: () => Promise<GraphData>;
  onAnyChange: (fn: (e?: VaultEvent) => void) => () => void;
}

/**
 * Loads the graph now and again `RELOAD_DELAY_MS` after files appear, move or go away (or after a
 * resync). Saving a note rarely changes the graph's shape, so `changed` events are ignored.
 * Returns the stop function.
 */
export function watchGraph(
  onData: (g: GraphData) => void,
  onError: () => void,
  deps: WatchGraphDeps = { load: api.graph, onAnyChange: (fn) => events.onAnyChange(fn) },
): () => void {
  let alive = true;
  let generation = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const load = () => {
    const g = ++generation;
    deps.load().then(
      (data) => {
        if (alive && g === generation) onData(data);
      },
      () => {
        if (alive && g === generation) onError();
      },
    );
  };
  load();
  const off = deps.onAnyChange((e) => {
    if (e?.type === 'changed') return;
    clearTimeout(timer);
    timer = setTimeout(load, RELOAD_DELAY_MS);
  });
  return () => {
    alive = false;
    off();
    clearTimeout(timer);
  };
}

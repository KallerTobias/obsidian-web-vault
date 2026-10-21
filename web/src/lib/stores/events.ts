import { writable, type Readable } from 'svelte/store';
import { api, type ChangesResult, type VaultEvent } from '../api';
import { applyRename } from '../editor/save';
import { vault } from './vault';
import { workspace } from './workspace';

/** How changes arrive: live stream, polling fallback, or not connected. */
export type EventsMode = 'sse' | 'polling' | 'off';

export interface EventsDeps {
  EventSource: typeof EventSource;
  changes: (since: number) => Promise<ChangesResult>;
  /** Every vault event, once, in order. */
  onEvent: (e: VaultEvent) => void;
  /** The client missed events it cannot catch up on: reload everything. */
  onResync: () => void;
}

export interface EventsStore {
  mode: Readable<EventsMode>;
  connect(): void;
  disconnect(): void;
  /** `fn` runs for created/changed/deleted events of exactly `path`. Returns the unsubscribe. */
  onNoteChanged(path: string, fn: (e: VaultEvent) => void): () => void;
  /** `fn` runs after every vault event (with it) and after a resync (without: anything may have changed). Returns the unsubscribe. */
  onAnyChange(fn: (e?: VaultEvent) => void): () => void;
}

/** Errors within this window … */
const ERROR_WINDOW_MS = 30_000;
/** … this many times: the stream does not work here (e.g. a buffering proxy), poll instead. */
const ERROR_LIMIT = 2;
const POLL_MS = 10_000;
/** While polling, try the stream again this often (it may have been a passing outage, e.g. a server restart). */
const SSE_RETRY_MS = 5 * 60_000;
const TYPES = ['created', 'changed', 'deleted', 'renamed'] as const;

export function createEvents(deps: EventsDeps): EventsStore {
  const mode = writable<EventsMode>('off');
  let source: EventSource | null = null;
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  /** Bumped whenever polling starts or stops: an answer from an older polling loop is dropped. */
  let pollGeneration = 0;
  let errors: number[] = [];
  /** Highest sequence number handled; events at or below it are replays. */
  let lastSeq = 0;
  /** lastSeq is meaningful (a stream said `ready` or a poll answered); before that, `ready` just sets it. */
  let synced = false;
  /** Stream events held back while missed events are fetched, so everything stays in order. */
  let held: VaultEvent[] | null = null;
  let current: EventsMode = 'off';
  const noteListeners = new Map<string, Set<(e: VaultEvent) => void>>();
  const anyListeners = new Set<(e?: VaultEvent) => void>();
  const notifyAny = (e?: VaultEvent) => {
    for (const fn of [...anyListeners]) fn(e);
  };

  const setMode = (m: EventsMode) => {
    current = m;
    mode.set(m);
  };

  function dispatch(e: VaultEvent): void {
    if (held) {
      held.push(e);
      return;
    }
    if (e.seq <= lastSeq) return;
    lastSeq = e.seq;
    deps.onEvent(e);
    if (e.type !== 'renamed') for (const fn of [...(noteListeners.get(e.path) ?? [])]) fn(e);
    notifyAny(e);
  }

  function resync(seq: number): void {
    lastSeq = seq;
    synced = true;
    deps.onResync();
    notifyAny();
  }

  /** Applies a `/api/changes` answer (poll or catch-up). */
  function applyChanges(r: ChangesResult): void {
    if ('resync' in r) resync(r.seq);
    else {
      r.events.forEach(dispatch);
      lastSeq = Math.max(lastSeq, r.seq);
      synced = true;
    }
  }

  /**
   * A new stream (not the browser's reconnect, which replays via Last-Event-ID) starts at the
   * server's current seq. Events between the last one seen and that point are fetched first.
   */
  function onReady(seq: number, es: EventSource): void {
    if (!synced) {
      lastSeq = seq;
      synced = true;
    } else if (seq < lastSeq) {
      resync(seq); // the server restarted: its counter began anew
    } else if (seq > lastSeq) {
      const mine: VaultEvent[] = [];
      held = mine;
      deps.changes(lastSeq).then(
        (r) => {
          if (held !== mine) return; // this stream was closed meanwhile
          held = null;
          applyChanges(r);
          mine.forEach(dispatch);
        },
        () => {
          if (held !== mine) return;
          held = null;
          resync(seq); // reloads everything, including what was held back
        },
      );
    }
  }

  function parse(e: MessageEvent): unknown {
    try {
      return JSON.parse(String(e.data));
    } catch {
      return undefined;
    }
  }

  const seqOf = (data: unknown) =>
    typeof data === 'object' && data !== null && typeof (data as { seq?: unknown }).seq === 'number'
      ? (data as { seq: number }).seq
      : undefined;

  function openStream(): void {
    const es = new deps.EventSource(api.events.url);
    source = es;
    for (const type of TYPES) {
      es.addEventListener(type, (e) => {
        const data = parse(e as MessageEvent);
        if (seqOf(data) !== undefined) dispatch(data as VaultEvent);
      });
    }
    // `ready` comes after any replay and carries the server's current seq.
    es.addEventListener('ready', (e) => {
      const seq = seqOf(parse(e as MessageEvent));
      if (seq !== undefined) onReady(seq, es);
    });
    es.addEventListener('resync', (e) => {
      const seq = seqOf(parse(e as MessageEvent));
      if (seq !== undefined) resync(seq);
    });
    es.onerror = () => {
      if (source !== es) return;
      const now = Date.now();
      errors = [...errors.filter((t) => now - t < ERROR_WINDOW_MS), now];
      // CLOSED: the browser gave up (HTTP error, wrong content type) and will not reconnect.
      if (errors.length >= ERROR_LIMIT || es.readyState === deps.EventSource.CLOSED) startPolling();
    };
  }

  function stopStream(): void {
    source?.close();
    source = null;
    held = null;
  }

  function startStream(): void {
    stopPolling();
    errors = [];
    setMode('sse');
    openStream();
  }

  function startPolling(): void {
    stopStream();
    stopPolling();
    setMode('polling');
    schedulePoll(pollGeneration);
    retryTimer = setTimeout(startStream, SSE_RETRY_MS);
  }

  function stopPolling(): void {
    pollGeneration++;
    clearTimeout(pollTimer);
    clearTimeout(retryTimer);
    pollTimer = retryTimer = undefined;
  }

  function schedulePoll(generation: number): void {
    pollTimer = setTimeout(async () => {
      try {
        const r = await deps.changes(lastSeq);
        if (generation !== pollGeneration) return;
        applyChanges(r);
      } catch {
        /* offline or session expired (the API client reports that): try again next round */
      }
      if (generation === pollGeneration) schedulePoll(generation);
    }, POLL_MS);
  }

  return {
    mode: { subscribe: mode.subscribe },
    connect() {
      if (current === 'off') startStream();
    },
    disconnect() {
      stopStream();
      stopPolling();
      setMode('off');
    },
    onNoteChanged(path, fn) {
      let set = noteListeners.get(path);
      if (!set) noteListeners.set(path, (set = new Set()));
      set.add(fn);
      return () => {
        set.delete(fn);
        if (set.size === 0) noteListeners.delete(path);
      };
    },
    onAnyChange(fn) {
      anyListeners.add(fn);
      return () => anyListeners.delete(fn);
    },
  };
}

/** The app's connection: events update the tree/lookup and the open tabs; a resync reloads both. */
export const events = createEvents({
  EventSource: globalThis.EventSource,
  changes: api.events.changes,
  onEvent: (e) => {
    // Open editors and stored drafts follow before the tabs remount their views.
    if (e.type === 'renamed') applyRename(e.from, e.to);
    workspace.applyEvent(e);
    vault.applyEvent(e);
  },
  onResync: () => {
    vault.load().catch(() => {
      /* offline: the next event or resync loads again */
    });
  },
});

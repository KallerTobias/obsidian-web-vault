/// <reference lib="dom" />
import { get } from 'svelte/store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChangesResult, VaultEvent } from '../../web/src/lib/api';
import { createEvents, type EventsStore } from '../../web/src/lib/stores/events';

/** Minimal stand-in for the browser's EventSource. */
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  readyState = FakeEventSource.CONNECTING;
  onerror: ((e: Event) => void) | null = null;
  onopen: ((e: Event) => void) | null = null;
  private listeners = new Map<string, ((e: MessageEvent) => void)[]>();
  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, fn: (e: MessageEvent) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  close(): void {
    this.readyState = FakeEventSource.CLOSED;
  }
  /** Server sends a frame. */
  emit(type: string, data: unknown, id = ''): void {
    this.readyState = FakeEventSource.OPEN;
    const e = new MessageEvent(type, { data: JSON.stringify(data), lastEventId: id });
    for (const fn of this.listeners.get(type) ?? []) fn(e);
  }
  /** Connection lost; the browser reconnects by itself (readyState CONNECTING) unless `fatal`. */
  fail(fatal = false): void {
    this.readyState = fatal ? FakeEventSource.CLOSED : FakeEventSource.CONNECTING;
    this.onerror?.(new Event('error'));
  }
}

const latest = () => FakeEventSource.instances.at(-1)!;
const ev = (seq: number, path: string, type: 'created' | 'changed' | 'deleted' = 'changed'): VaultEvent => ({ seq, type, path });

let received: VaultEvent[];
let resyncs: number;
let changes: ReturnType<typeof vi.fn<(since: number) => Promise<ChangesResult>>>;
let events: EventsStore;

beforeEach(() => {
  vi.useFakeTimers();
  FakeEventSource.instances = [];
  received = [];
  resyncs = 0;
  changes = vi.fn(async (since: number): Promise<ChangesResult> => ({ seq: since, events: [] }));
  events = createEvents({
    EventSource: FakeEventSource as unknown as typeof EventSource,
    changes,
    onEvent: (e) => received.push(e),
    onResync: () => resyncs++,
  });
});
afterEach(() => {
  events.disconnect();
  vi.useRealTimers();
});

describe('events: server-sent events', () => {
  it('connects to /api/events and passes vault events on in order', () => {
    events.connect();
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(latest().url).toBe('/api/events');
    latest().emit('ready', { seq: 4 }, '4');
    latest().emit('created', ev(5, 'A.md', 'created'), '5');
    latest().emit('renamed', { seq: 6, type: 'renamed', from: 'A.md', to: 'B.md' }, '6');
    expect(received.map((e) => e.seq)).toEqual([5, 6]);
    expect(get(events.mode)).toBe('sse');
  });

  it('connect() twice keeps one connection', () => {
    events.connect();
    events.connect();
    expect(FakeEventSource.instances).toHaveLength(1);
  });

  it('skips events it has already seen (replay after reconnect)', () => {
    events.connect();
    latest().emit('changed', ev(7, 'A.md'), '7');
    latest().emit('changed', ev(7, 'A.md'), '7');
    latest().emit('changed', ev(6, 'A.md'), '6');
    expect(received).toHaveLength(1);
  });

  it('resync reloads (callback) and continues with the new sequence number', () => {
    events.connect();
    latest().emit('changed', ev(50, 'A.md'), '50');
    // Server restarted: its counter began anew.
    latest().emit('resync', { seq: 3 }, '3');
    expect(resyncs).toBe(1);
    latest().emit('changed', ev(4, 'A.md'), '4');
    expect(received.map((e) => e.seq)).toEqual([50, 4]);
  });

  it('onNoteChanged calls back only for its path until unsubscribed', () => {
    events.connect();
    const fn = vi.fn();
    const off = events.onNoteChanged('Ordner/Ä b.md', fn);
    latest().emit('changed', ev(1, 'Ordner/Ä b.md'), '1');
    latest().emit('changed', ev(2, 'Anderes.md'), '2');
    latest().emit('deleted', ev(3, 'Ordner/Ä b.md', 'deleted'), '3');
    expect(fn.mock.calls.map((c) => (c[0] as VaultEvent).seq)).toEqual([1, 3]);
    off();
    latest().emit('changed', ev(4, 'Ordner/Ä b.md'), '4');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('onAnyChange calls back for every event and on a resync until unsubscribed', () => {
    events.connect();
    const fn = vi.fn();
    const off = events.onAnyChange(fn);
    latest().emit('changed', ev(1, 'A.md'), '1');
    latest().emit('deleted', ev(2, 'B.md', 'deleted'), '2');
    latest().emit('resync', { seq: 9 });
    expect(fn).toHaveBeenCalledTimes(3);
    expect(fn.mock.calls.map((c) => (c[0] as VaultEvent | undefined)?.type)).toEqual(['changed', 'deleted', undefined]);
    off();
    latest().emit('changed', ev(10, 'A.md'), '10');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('a single error leaves reconnecting to the browser', () => {
    events.connect();
    latest().fail();
    vi.advanceTimersByTime(60_000);
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(latest().readyState).not.toBe(FakeEventSource.CLOSED);
    expect(changes).not.toHaveBeenCalled();
    expect(get(events.mode)).toBe('sse');
  });

  it('two errors more than 30 s apart do not switch to polling', () => {
    events.connect();
    latest().fail();
    vi.advanceTimersByTime(31_000);
    latest().fail();
    expect(get(events.mode)).toBe('sse');
    vi.advanceTimersByTime(20_000);
    expect(changes).not.toHaveBeenCalled();
  });
});

describe('events: polling fallback', () => {
  it('two errors within 30 s close the stream and poll /api/changes every 10 s', async () => {
    events.connect();
    latest().emit('ready', { seq: 10 }, '10');
    latest().fail();
    vi.advanceTimersByTime(29_000);
    latest().fail();
    expect(latest().readyState).toBe(FakeEventSource.CLOSED);
    expect(get(events.mode)).toBe('polling');
    expect(changes).not.toHaveBeenCalled();

    changes.mockResolvedValueOnce({ seq: 12, events: [ev(11, 'A.md'), ev(12, 'B.md')] });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(changes).toHaveBeenLastCalledWith(10);
    expect(received.map((e) => e.seq)).toEqual([11, 12]);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(changes).toHaveBeenLastCalledWith(12);
    expect(changes).toHaveBeenCalledTimes(2);
    expect(FakeEventSource.instances).toHaveLength(1);
  });

  it('a stream the browser gave up on (closed, e.g. HTTP error) switches to polling at once', () => {
    events.connect();
    latest().fail(true);
    expect(get(events.mode)).toBe('polling');
  });

  it('polling: resync reloads and continues from the given seq', async () => {
    events.connect();
    latest().fail(true);
    changes.mockResolvedValueOnce({ resync: true, seq: 99 });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(resyncs).toBe(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(changes).toHaveBeenLastCalledWith(99);
  });

  it('polling survives a failed request', async () => {
    events.connect();
    latest().fail(true);
    changes.mockRejectedValueOnce(new Error('offline'));
    await vi.advanceTimersByTimeAsync(10_000);
    changes.mockResolvedValueOnce({ seq: 1, events: [ev(1, 'A.md')] });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(received.map((e) => e.seq)).toEqual([1]);
  });

  it('tries the stream again after 5 minutes of polling', async () => {
    events.connect();
    latest().fail(true);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(get(events.mode)).toBe('sse');
    const polls = changes.mock.calls.length;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(changes).toHaveBeenCalledTimes(polls);
    // Still broken: back to polling after two errors.
    latest().fail();
    latest().fail();
    expect(get(events.mode)).toBe('polling');
  });

  it('a poll answer arriving after a reconnect does not start a second polling loop', async () => {
    let answer: (r: ChangesResult) => void = () => {};
    changes.mockImplementationOnce(() => new Promise((res) => (answer = res)));
    events.connect();
    latest().fail(true);
    await vi.advanceTimersByTimeAsync(10_000); // first poll pending
    events.disconnect();
    events.connect();
    latest().fail(true); // polling again
    answer({ seq: 0, events: [] });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(changes).toHaveBeenCalledTimes(2);
  });

  it('a new stream catches up on events it missed since the last poll, in order', async () => {
    events.connect();
    latest().emit('ready', { seq: 10 }, '10');
    latest().fail(true);
    changes.mockResolvedValue({ seq: 10, events: [] });
    await vi.advanceTimersByTimeAsync(5 * 60_000); // polls, then the stream again
    let answer: (r: ChangesResult) => void = () => {};
    changes.mockImplementationOnce(() => new Promise((res) => (answer = res)));
    latest().emit('ready', { seq: 12 }, '12'); // 11 and 12 happened in between
    expect(changes).toHaveBeenLastCalledWith(10);
    latest().emit('changed', ev(13, 'C.md'), '13'); // arrives while catching up
    answer({ seq: 12, events: [ev(11, 'A.md'), ev(12, 'B.md')] });
    await vi.advanceTimersByTimeAsync(0);
    expect(received.map((e) => e.seq)).toEqual([11, 12, 13]);
  });

  it('a new stream from a restarted server (lower seq) resyncs', async () => {
    events.connect();
    latest().emit('ready', { seq: 10 }, '10');
    events.disconnect();
    events.connect();
    latest().emit('ready', { seq: 2 }, '2');
    expect(resyncs).toBe(1);
    latest().emit('changed', ev(3, 'A.md'), '3');
    expect(received.map((e) => e.seq)).toEqual([3]);
  });

  it('disconnect stops polling', async () => {
    events.connect();
    latest().fail(true);
    events.disconnect();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(changes).not.toHaveBeenCalled();
    expect(get(events.mode)).toBe('off');
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../web/src/lib/api';
import {
  applyRename,
  conflictCopyPath,
  draftStorage,
  flushSaversUnder,
  NoteSaver,
  readDraft,
  type NoteApi,
} from '../../web/src/lib/editor/save';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** In-memory Storage (jsdom's localStorage is shared between tests). */
function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k) => map.get(k) ?? null,
    key: (i) => [...map.keys()][i] ?? null,
    removeItem: (k) => void map.delete(k),
    setItem: (k, v) => void map.set(k, String(v)),
  };
}

type SaveCall = { path: string; content: string; baseVersion: string };

/** A fake `api.note`: saves answer in order from `saveAnswers` (deferreds or values). */
function fakeApi() {
  const saves: SaveCall[] = [];
  const pending: Deferred<{ version: string }>[] = [];
  const api = {
    get: vi.fn(async (_path: string) => ({ content: 'disk text', version: 'vDisk', readonly: false })),
    save: vi.fn((path: string, content: string, baseVersion: string) => {
      saves.push({ path, content, baseVersion });
      const d = deferred<{ version: string }>();
      pending.push(d);
      return d.promise;
    }),
    create: vi.fn(async (path: string, _content: string) => ({ path, version: `vCreated:${path}` })),
  } satisfies NoteApi;
  /** Answers the oldest unanswered save. */
  const answer = async (result: { version: string } | Error) => {
    const d = pending.shift()!;
    if (result instanceof Error) d.reject(result);
    else d.resolve(result);
    await vi.advanceTimersByTimeAsync(0);
  };
  return { api, saves, answer };
}

const conflictError = (diskContent: string | null, diskVersion: string | null) =>
  new ApiError(409, { error: 'Konflikt', diskContent, diskVersion });

let storage: Storage;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 9, 20, 14, 7));
  storage = memoryStorage();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('NoteSaver', () => {
  it('debounces edits: several edits make one PUT after 800 ms', async () => {
    const { api, saves, answer } = fakeApi();
    const s = new NoteSaver('A.md', 'v0', api, storage, { content: 'a' });
    expect(s.state).toBe('saved');
    s.edit('ab');
    s.edit('abc');
    expect(s.state).toBe('dirty');
    await vi.advanceTimersByTimeAsync(799);
    expect(saves).toHaveLength(0);
    s.edit('abcd');
    await vi.advanceTimersByTimeAsync(799);
    expect(saves).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(saves).toEqual([{ path: 'A.md', content: 'abcd', baseVersion: 'v0' }]);
    expect(s.state).toBe('saving');
    await answer({ version: 'v1' });
    expect(s.state).toBe('saved');
    expect(s.version).toBe('v1');
  });

  it('an edit back to the saved text needs no PUT', async () => {
    const { api, saves } = fakeApi();
    const s = new NoteSaver('A.md', 'v0', api, storage, { content: 'a' });
    s.edit('ab');
    s.edit('a');
    expect(s.state).toBe('saved');
    await vi.advanceTimersByTimeAsync(2000);
    expect(saves).toHaveLength(0);
  });

  it('typing during a running PUT: the next PUT builds on the version of the first answer', async () => {
    const { api, saves, answer } = fakeApi();
    const s = new NoteSaver('A.md', 'v0', api, storage, { content: '' });
    s.edit('one');
    await vi.advanceTimersByTimeAsync(800);
    expect(saves).toHaveLength(1);
    s.edit('one two');
    expect(s.state).toBe('saving');
    await vi.advanceTimersByTimeAsync(800);
    // Never two PUTs in flight for one note.
    expect(saves).toHaveLength(1);
    await answer({ version: 'v1' });
    await vi.advanceTimersByTimeAsync(800);
    expect(saves).toHaveLength(2);
    expect(saves[1]).toEqual({ path: 'A.md', content: 'one two', baseVersion: 'v1' });
    await answer({ version: 'v2' });
    expect(s.state).toBe('saved');
    expect(s.version).toBe('v2');
  });

  it('flush() saves at once and waits for it', async () => {
    const { api, saves, answer } = fakeApi();
    const s = new NoteSaver('A.md', 'v0', api, storage, { content: '' });
    s.edit('x');
    const done = s.flush();
    expect(saves).toHaveLength(1);
    await answer({ version: 'v1' });
    await done;
    expect(s.state).toBe('saved');
  });

  it('409: state conflict with the disk version, no further PUT', async () => {
    const { api, saves, answer } = fakeApi();
    const s = new NoteSaver('A.md', 'v0', api, storage, { content: '' });
    s.edit('mine');
    await vi.advanceTimersByTimeAsync(800);
    await answer(conflictError('theirs', 'vX'));
    expect(s.state).toBe('conflict');
    expect(s.conflict).toEqual({ mine: 'mine', diskContent: 'theirs', diskVersion: 'vX' });
    s.edit('mine 2');
    expect(s.conflict?.mine).toBe('mine 2');
    await vi.advanceTimersByTimeAsync(60_000);
    await s.flush();
    expect(saves).toHaveLength(1);
  });

  it('external change while saved: reloads the disk text', async () => {
    const { api } = fakeApi();
    const onReload = vi.fn();
    const s = new NoteSaver('A.md', 'v0', api, storage, { content: 'old', onReload });
    await expect(s.onExternalChange('vDisk')).resolves.toBe('reloaded');
    expect(api.get).toHaveBeenCalledWith('A.md');
    expect(onReload).toHaveBeenCalledWith('disk text');
    expect(s.version).toBe('vDisk');
    expect(s.state).toBe('saved');
  });

  it('external change while dirty: conflict (mine vs. disk), nothing saved', async () => {
    const { api, saves } = fakeApi();
    const onReload = vi.fn();
    const s = new NoteSaver('A.md', 'v0', api, storage, { content: 'old', onReload });
    s.edit('mine');
    await expect(s.onExternalChange('vDisk')).resolves.toBe('conflict');
    expect(s.state).toBe('conflict');
    expect(s.conflict).toEqual({ mine: 'mine', diskContent: 'disk text', diskVersion: 'vDisk' });
    await vi.advanceTimersByTimeAsync(5000);
    expect(saves).toHaveLength(0);
    expect(onReload).not.toHaveBeenCalled();
  });

  it('external change while dirty but the disk text cannot be fetched: stays offline and retries, no "deleted" conflict', async () => {
    const { api, saves, answer } = fakeApi();
    api.get.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const s = new NoteSaver('A.md', 'v0', api, storage, { content: 'old' });
    s.edit('mine');
    await expect(s.onExternalChange('vDisk')).resolves.toBe('ignored');
    expect(s.conflict).toBeNull();
    expect(s.state).toBe('offline');
    expect(readDraft(storage, 'A.md')).toMatchObject({ content: 'mine', baseVersion: 'v0' });
    await vi.advanceTimersByTimeAsync(2000);
    expect(saves).toEqual([{ path: 'A.md', content: 'mine', baseVersion: 'v0' }]);
    // the retried save meets the external change: a real conflict with the disk text
    await answer(new ApiError(409, { error: 'Konflikt', diskContent: 'disk text', diskVersion: 'vDisk' }));
    expect(s.conflict).toEqual({ mine: 'mine', diskContent: 'disk text', diskVersion: 'vDisk' });
  });

  it('typing while the reloaded text is fetched: conflict instead of overwriting the typing', async () => {
    const { api } = fakeApi();
    const got = deferred<{ content: string; version: string; readonly: boolean }>();
    api.get.mockReturnValueOnce(got.promise);
    const onReload = vi.fn();
    const s = new NoteSaver('A.md', 'v0', api, storage, { content: 'old', onReload });
    const result = s.onExternalChange('vDisk');
    s.edit('typed');
    got.resolve({ content: 'disk text', version: 'vDisk', readonly: false });
    await expect(result).resolves.toBe('conflict');
    expect(onReload).not.toHaveBeenCalled();
    expect(s.conflict).toEqual({ mine: 'typed', diskContent: 'disk text', diskVersion: 'vDisk' });
  });

  it('own saves cause no conflict, also when the echo arrives before the PUT answer', async () => {
    const { api, answer } = fakeApi();
    const s = new NoteSaver('A.md', 'v0', api, storage, { content: '' });
    s.edit('one');
    await vi.advanceTimersByTimeAsync(800);
    s.edit('one two'); // dirty again while the PUT runs
    const echo = s.onExternalChange('v1');
    await answer({ version: 'v1' });
    await expect(echo).resolves.toBe('ignored');
    // The echo of an older own save, arriving after a newer one, is ours too.
    await vi.advanceTimersByTimeAsync(800);
    await answer({ version: 'v2' });
    await expect(s.onExternalChange('v1')).resolves.toBe('ignored');
    await expect(s.onExternalChange('v2')).resolves.toBe('ignored');
    expect(s.state).toBe('saved');
    expect(api.get).not.toHaveBeenCalled();
  });

  it('401: keeps the text as a draft, state offline; after a new login flush() saves and removes the draft', async () => {
    const { api, saves, answer } = fakeApi();
    const s = new NoteSaver('Ordner/A b.md', 'v0', api, storage, { content: '' });
    s.edit('wichtig');
    await vi.advanceTimersByTimeAsync(800);
    await answer(new ApiError(401, { error: 'Nicht angemeldet' }));
    expect(s.state).toBe('offline');
    const draft = JSON.parse(storage.getItem('vw-draft:Ordner/A b.md')!);
    expect(draft).toEqual({ content: 'wichtig', baseVersion: 'v0', savedAt: Date.now() });
    // No retries while logged out: the login comes first.
    await vi.advanceTimersByTimeAsync(120_000);
    expect(saves).toHaveLength(1);
    // Typing goes on while offline: the draft follows.
    s.edit('wichtig!');
    expect(readDraft(storage, 'Ordner/A b.md')?.content).toBe('wichtig!');
    expect(s.state).toBe('offline');

    const done = s.flush();
    expect(saves[1]).toEqual({ path: 'Ordner/A b.md', content: 'wichtig!', baseVersion: 'v0' });
    await answer({ version: 'v1' });
    await done;
    expect(s.state).toBe('saved');
    expect(storage.getItem('vw-draft:Ordner/A b.md')).toBeNull();
  });

  it('network failure: draft and retries after 2 s, 5 s, 10 s, then every 30 s', async () => {
    const { api, saves, answer } = fakeApi();
    const s = new NoteSaver('A.md', 'v0', api, storage, { content: '' });
    s.edit('x');
    await vi.advanceTimersByTimeAsync(800);
    const fail = () => answer(new TypeError('Failed to fetch'));
    await fail();
    expect(s.state).toBe('offline');
    expect(readDraft(storage, 'A.md')).toMatchObject({ content: 'x', baseVersion: 'v0' });
    for (const [delay, count] of [[2000, 2], [5000, 3], [10_000, 4], [30_000, 5], [30_000, 6]] as const) {
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(saves).toHaveLength(count - 1);
      await vi.advanceTimersByTimeAsync(1);
      expect(saves).toHaveLength(count);
      await fail();
    }
    await vi.advanceTimersByTimeAsync(30_000);
    await answer({ version: 'v1' });
    expect(s.state).toBe('saved');
    expect(readDraft(storage, 'A.md')).toBeNull();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(saves).toHaveLength(7);
  });

  it('readonly notes are never saved', async () => {
    const { api, saves } = fakeApi();
    const s = new NoteSaver('A.md', 'v0', api, storage, { content: '', readonly: true });
    s.edit('x');
    await vi.advanceTimersByTimeAsync(5000);
    await s.flush();
    expect(saves).toHaveLength(0);
    expect(s.state).toBe('saved');
  });

  describe('resolve', () => {
    async function inConflict() {
      const f = fakeApi();
      const onReload = vi.fn();
      const s = new NoteSaver('Ordner/Notiz.md', 'v0', f.api, storage, { content: 'base', onReload });
      s.edit('mine');
      await vi.advanceTimersByTimeAsync(800);
      await f.answer(conflictError('theirs', 'vX'));
      expect(s.state).toBe('conflict');
      return { ...f, s, onReload };
    }

    it("'mine' saves my text on top of the disk version", async () => {
      const { s, saves, answer } = await inConflict();
      const done = s.resolve('mine');
      await vi.advanceTimersByTimeAsync(0);
      expect(saves[1]).toEqual({ path: 'Ordner/Notiz.md', content: 'mine', baseVersion: 'vX' });
      await answer({ version: 'v2' });
      await done;
      expect(s.state).toBe('saved');
      expect(s.conflict).toBeNull();
    });

    it("'mine' recreates a note that was deleted on disk", async () => {
      const f = fakeApi();
      const s = new NoteSaver('A.md', 'v0', f.api, storage, { content: '' });
      s.edit('mine');
      await vi.advanceTimersByTimeAsync(800);
      await f.answer(conflictError(null, null));
      await s.resolve('mine');
      expect(f.api.create).toHaveBeenCalledWith('A.md', 'mine');
      expect(s.state).toBe('saved');
      expect(s.version).toBe('vCreated:A.md');
    });

    it("'disk' drops my text and loads the disk version", async () => {
      const { s, saves, onReload } = await inConflict();
      await s.resolve('disk');
      expect(onReload).toHaveBeenCalledWith('theirs');
      expect(s.state).toBe('saved');
      expect(s.version).toBe('vX');
      expect(saves).toHaveLength(1);
    });

    it("'both' creates a conflict copy via POST /api/note and loads the disk version", async () => {
      const { s, api, onReload } = await inConflict();
      await s.resolve('both');
      expect(api.create).toHaveBeenCalledWith('Ordner/Notiz (Konflikt 2026-10-20 1407).md', 'mine');
      expect(onReload).toHaveBeenCalledWith('theirs');
      expect(s.state).toBe('saved');
      expect(s.version).toBe('vX');
    });

    it("'both' picks a free name when the copy exists already", async () => {
      const { s, api } = await inConflict();
      api.create.mockRejectedValueOnce(conflictError('x', 'vY'));
      await s.resolve('both');
      expect(api.create).toHaveBeenLastCalledWith('Ordner/Notiz (Konflikt 2026-10-20 1407) 2.md', 'mine');
    });

    it('a failed resolution keeps the conflict', async () => {
      const { s, api } = await inConflict();
      api.create.mockRejectedValueOnce(new TypeError('Failed to fetch'));
      await expect(s.resolve('both')).rejects.toThrow();
      expect(s.state).toBe('conflict');
      expect(s.conflict?.mine).toBe('mine');
    });
  });

  describe('drafts on opening', () => {
    it('restores a draft made on the same disk version and saves it', async () => {
      const { api, saves } = fakeApi();
      storage.setItem('vw-draft:A.md', JSON.stringify({ content: 'draft', baseVersion: 'v0', savedAt: 1 }));
      const s = new NoteSaver('A.md', 'v0', api, storage, { content: 'disk' });
      expect(s.restoreDraft()).toBe('restored');
      expect(s.text).toBe('draft');
      expect(s.state).toBe('dirty');
      await vi.advanceTimersByTimeAsync(800);
      expect(saves).toEqual([{ path: 'A.md', content: 'draft', baseVersion: 'v0' }]);
    });

    it('a draft on an older disk version is a conflict', () => {
      const { api } = fakeApi();
      storage.setItem('vw-draft:A.md', JSON.stringify({ content: 'draft', baseVersion: 'vOld', savedAt: 1 }));
      const s = new NoteSaver('A.md', 'v0', api, storage, { content: 'disk' });
      expect(s.restoreDraft()).toBe('conflict');
      expect(s.conflict).toEqual({ mine: 'draft', diskContent: 'disk', diskVersion: 'v0' });
    });

    it('a draft equal to the disk text is just removed', () => {
      const { api } = fakeApi();
      storage.setItem('vw-draft:A.md', JSON.stringify({ content: 'disk', baseVersion: 'vOld', savedAt: 1 }));
      const s = new NoteSaver('A.md', 'v0', api, storage, { content: 'disk' });
      expect(s.restoreDraft()).toBe('none');
      expect(storage.getItem('vw-draft:A.md')).toBeNull();
    });

    it('broken drafts and broken storage are ignored', () => {
      const { api } = fakeApi();
      storage.setItem('vw-draft:A.md', '{nope');
      expect(new NoteSaver('A.md', 'v0', api, storage, { content: '' }).restoreDraft()).toBe('none');
      const broken = memoryStorage();
      broken.getItem = () => {
        throw new Error('blocked');
      };
      expect(new NoteSaver('A.md', 'v0', api, broken, { content: '' }).restoreDraft()).toBe('none');
    });
  });

  it('close() keeps unsaved text as a draft and still tries to save it', async () => {
    const { api, saves, answer } = fakeApi();
    const s = new NoteSaver('A.md', 'v0', api, storage, { content: '' });
    s.edit('x');
    s.close();
    expect(readDraft(storage, 'A.md')?.content).toBe('x');
    expect(saves).toHaveLength(1);
    await answer({ version: 'v1' });
    expect(readDraft(storage, 'A.md')).toBeNull();
  });

  it('deleted on disk: no more saves until saved as a new note', async () => {
    const { api, saves } = fakeApi();
    const s = new NoteSaver('A.md', 'v0', api, storage, { content: '' });
    s.edit('x');
    s.markDeleted();
    await vi.advanceTimersByTimeAsync(5000);
    expect(saves).toHaveLength(0);
    expect(s.deleted).toBe(true);
    expect(s.state).toBe('dirty');
    await s.saveAsNew();
    expect(api.create).toHaveBeenCalledWith('A.md', 'x');
    expect(s.deleted).toBe(false);
    expect(s.state).toBe('saved');
  });
  describe('conflict found while a PUT is running', () => {
    /** Dirty → external event → the debounced PUT starts during the GET → GET answers (conflict) → PUT settles. */
    async function sequence() {
      const f = fakeApi();
      const got = deferred<{ content: string; version: string; readonly: boolean }>();
      f.api.get.mockReturnValueOnce(got.promise);
      const s = new NoteSaver('A.md', 'v0', f.api, storage, { content: '' });
      s.edit('mine');
      const ext = s.onExternalChange('vX');
      await vi.advanceTimersByTimeAsync(800);
      expect(f.saves).toHaveLength(1);
      got.resolve({ content: 'theirs', version: 'vX', readonly: false });
      await expect(ext).resolves.toBe('conflict');
      expect(s.state).toBe('conflict');
      return { ...f, s };
    }

    it('PUT fails: the conflict stays (dialog), the text is in the draft, edits follow the draft', async () => {
      const { s, saves, answer } = await sequence();
      await answer(new TypeError('Failed to fetch'));
      expect(s.state).toBe('conflict');
      expect(s.conflict).toEqual({ mine: 'mine', diskContent: 'theirs', diskVersion: 'vX' });
      expect(readDraft(storage, 'A.md')?.content).toBe('mine');
      s.edit('mine 2');
      expect(readDraft(storage, 'A.md')?.content).toBe('mine 2');
      await vi.advanceTimersByTimeAsync(120_000);
      expect(saves).toHaveLength(1);
    });

    it('PUT succeeds: the conflict stays until decided, its version is known as ours', async () => {
      const { s, answer } = await sequence();
      await answer({ version: 'v1' });
      expect(s.state).toBe('conflict');
      expect(s.conflict).toEqual({ mine: 'mine', diskContent: 'theirs', diskVersion: 'vX' });
      await expect(s.onExternalChange('v1')).resolves.toBe('ignored');
    });
  });

  it('a conflict where my text equals the disk text adopts the disk version without asking', async () => {
    const { api, answer } = fakeApi();
    const s = new NoteSaver('A.md', 'v0', api, storage, { content: '' });
    s.edit('same');
    await vi.advanceTimersByTimeAsync(800);
    await answer(conflictError('same', 'vX'));
    expect(s.state).toBe('saved');
    expect(s.conflict).toBeNull();
    expect(s.version).toBe('vX');
    expect(readDraft(storage, 'A.md')).toBeNull();
  });

  it('a refused text (4xx): state error with the message, draft kept, no automatic retries; editing tries again', async () => {
    const { api, saves, answer } = fakeApi();
    const s = new NoteSaver('A.md', 'v0', api, storage, { content: '' });
    s.edit('riesig');
    await vi.advanceTimersByTimeAsync(800);
    await answer(new ApiError(413, { error: 'Datei zu groß' }));
    expect(s.state).toBe('error');
    expect(s.errorMessage).toBe('Datei zu groß');
    expect(readDraft(storage, 'A.md')?.content).toBe('riesig');
    await vi.advanceTimersByTimeAsync(120_000);
    expect(saves).toHaveLength(1);
    s.edit('klein');
    expect(readDraft(storage, 'A.md')?.content).toBe('klein');
    await vi.advanceTimersByTimeAsync(800);
    expect(saves[1]?.content).toBe('klein');
    await answer({ version: 'v1' });
    expect(s.state).toBe('saved');
  });

  it('408 and 429 are retried like network errors', async () => {
    const { api, saves, answer } = fakeApi();
    const s = new NoteSaver('A.md', 'v0', api, storage, { content: '' });
    s.edit('x');
    await vi.advanceTimersByTimeAsync(800);
    await answer(new ApiError(429, { error: 'Zu viele Anfragen' }));
    expect(s.state).toBe('offline');
    await vi.advanceTimersByTimeAsync(2000);
    expect(saves).toHaveLength(2);
    await answer(new ApiError(408, undefined));
    expect(s.state).toBe('offline');
  });

  it('deleted during a save loop: does not stay in saving', async () => {
    const { api, saves, answer } = fakeApi();
    const s = new NoteSaver('A.md', 'v0', api, storage, { content: '' });
    s.edit('a');
    await vi.advanceTimersByTimeAsync(800);
    s.edit('ab');
    s.markDeleted();
    await answer({ version: 'v1' });
    expect(saves).toHaveLength(1);
    expect(s.state).toBe('dirty');
    expect(s.deleted).toBe(true);
    expect(s.version).toBeNull();
  });

  describe('renames', () => {
    it('before an in-app rename, pending edits below the path are saved to the old path', async () => {
      const { api, saves, answer } = fakeApi();
      const s = new NoteSaver('Umbenennen/A.md', 'v0', api, storage, { content: '' });
      s.edit('getippt');
      const done = flushSaversUnder('Umbenennen');
      expect(saves).toEqual([{ path: 'Umbenennen/A.md', content: 'getippt', baseVersion: 'v0' }]);
      await answer({ version: 'v1' });
      await done;
      expect(s.state).toBe('saved');
      s.close();
    });

    it('rename within the debounce: the pending text is saved at the new path', async () => {
      const { api, saves, answer } = fakeApi();
      const s = new NoteSaver('Alt1.md', 'v0', api, storage, { content: '' });
      s.edit('getippt');
      applyRename('Alt1.md', 'Neu1.md', storage);
      expect(s.path).toBe('Neu1.md');
      // The view is remounted for the new path: the old saver closes.
      s.close();
      expect(readDraft(storage, 'Neu1.md')?.content).toBe('getippt');
      expect(saves).toEqual([{ path: 'Neu1.md', content: 'getippt', baseVersion: 'v0' }]);
      await answer({ version: 'v1' });
      expect(readDraft(storage, 'Neu1.md')).toBeNull();
      expect(readDraft(storage, 'Alt1.md')).toBeNull();
    });

    it('a closed saver still saving follows a rename that arrives afterwards', async () => {
      const { api, saves, answer } = fakeApi();
      const s = new NoteSaver('Alt2.md', 'v0', api, storage, { content: '' });
      s.edit('a');
      s.close(); // PUT to Alt2.md running, draft at Alt2.md
      applyRename('Alt2.md', 'Neu2.md', storage);
      expect(readDraft(storage, 'Neu2.md')?.content).toBe('a');
      await answer(conflictError(null, null)); // the old path is gone
      // No UI-less conflict at a vanished path: the text stays as the draft of the new path.
      expect(readDraft(storage, 'Neu2.md')?.content).toBe('a');
      expect(saves).toHaveLength(1);
    });

    it('external folder rename while dirty/offline: the draft moves, later saves go to the new path', async () => {
      const { api, saves, answer } = fakeApi();
      const s = new NoteSaver('Mappe/Sub/A.md', 'v0', api, storage, { content: '' });
      storage.setItem('vw-draft:Mappe/B.md', JSON.stringify({ content: 'b', baseVersion: 'vb', savedAt: 1 }));
      storage.setItem('vw-draft:Mappenfremd.md', JSON.stringify({ content: 'c', baseVersion: 'vc', savedAt: 1 }));
      s.edit('x');
      await vi.advanceTimersByTimeAsync(800);
      await answer(new TypeError('Failed to fetch'));
      expect(readDraft(storage, 'Mappe/Sub/A.md')?.content).toBe('x');
      applyRename('Mappe', 'Ordner Neu', storage);
      expect(readDraft(storage, 'Mappe/Sub/A.md')).toBeNull();
      expect(readDraft(storage, 'Ordner Neu/Sub/A.md')?.content).toBe('x');
      expect(readDraft(storage, 'Ordner Neu/B.md')?.content).toBe('b');
      expect(readDraft(storage, 'Mappenfremd.md')?.content).toBe('c');
      await vi.advanceTimersByTimeAsync(2000);
      expect(saves[1]?.path).toBe('Ordner Neu/Sub/A.md');
      s.close();
    });

    it('never overwrites a draft that already exists at the target', () => {
      storage.setItem('vw-draft:X.md', JSON.stringify({ content: 'x', baseVersion: 'v', savedAt: 1 }));
      storage.setItem('vw-draft:Y.md', JSON.stringify({ content: 'y', baseVersion: 'v', savedAt: 1 }));
      applyRename('X.md', 'Y.md', storage);
      expect(readDraft(storage, 'Y.md')?.content).toBe('y');
      expect(readDraft(storage, 'X.md')?.content).toBe('x');
    });
  });
});

describe('draftStorage', () => {
  it('is one shared stand-in when localStorage is blocked', () => {
    const spy = vi.spyOn(globalThis, 'localStorage', 'get').mockImplementation(() => {
      throw new Error('blocked');
    });
    try {
      const a = draftStorage();
      a.setItem('vw-draft:A.md', 'x');
      expect(draftStorage()).toBe(a);
      expect(draftStorage().getItem('vw-draft:A.md')).toBe('x');
    } finally {
      spy.mockRestore();
    }
  });
});

describe('conflictCopyPath', () => {
  it('puts the copy next to the original, in local time', () => {
    const at = new Date(2026, 0, 5, 9, 3);
    expect(conflictCopyPath('Ordner/Sub/Notiz.md', at)).toBe('Ordner/Sub/Notiz (Konflikt 2026-01-05 0903).md');
    expect(conflictCopyPath('Notiz.md', at, 3)).toBe('Notiz (Konflikt 2026-01-05 0903) 3.md');
  });
});

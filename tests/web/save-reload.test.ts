import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NoteSaver, readDraft, saveAllBeforeReload, warnBeforeUnload, type NoteApi } from '../../web/src/lib/editor/save';
import * as i18n from '../../web/src/lib/i18n';

vi.mock('../../web/src/lib/i18n', async (orig) => {
  const mod = await orig<typeof import('../../web/src/lib/i18n')>();
  return { ...mod, isLanguageReload: vi.fn(() => false) };
});

// Own file: `saveAllBeforeReload` covers every open saver of the module, so no savers of other tests may linger.

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

let storage: Storage;
beforeEach(() => {
  vi.useFakeTimers();
  storage = memoryStorage();
});
afterEach(() => vi.useRealTimers());

describe('saveAllBeforeReload (language change)', () => {
  it('saves pending edits right away instead of after the debounce, and waits for them', async () => {
    let finish!: (v: { version: string }) => void;
    const api: NoteApi = {
      get: vi.fn(),
      save: vi.fn(() => new Promise<{ version: string }>((resolve) => (finish = resolve))),
      create: vi.fn(),
    };
    const s = new NoteSaver('A.md', 'v0', api, storage, { content: '' });
    s.edit('getippt');
    let done = false;
    const p = saveAllBeforeReload().then(() => (done = true));
    expect(api.save).toHaveBeenCalledWith('A.md', 'getippt', 'v0');
    await vi.advanceTimersByTimeAsync(0);
    expect(done).toBe(false);
    finish({ version: 'v1' });
    await p;
    expect(s.state).toBe('saved');
    expect(s.unsaved).toBe(false);
    expect(readDraft(storage, 'A.md')).toBeNull();
    s.close();
  });

  it('a failed save leaves the text as a draft (restored after the reload) and still resolves', async () => {
    const api: NoteApi = {
      get: vi.fn(),
      save: vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
      create: vi.fn(),
    };
    const s = new NoteSaver('B.md', 'v0', api, storage, { content: '' });
    s.edit('offline getippt');
    await saveAllBeforeReload();
    expect(readDraft(storage, 'B.md')?.content).toBe('offline getippt');
    expect(s.state).toBe('offline');
    s.close();
  });
});

describe('warnBeforeUnload (leaving the page)', () => {
  const api: NoteApi = { get: vi.fn(), save: vi.fn(() => new Promise<never>(() => {})), create: vi.fn() };
  const unload = () => {
    const e = new Event('beforeunload', { cancelable: true }) as BeforeUnloadEvent;
    warnBeforeUnload(e);
    return e;
  };

  it('nothing unsaved: no prompt', () => {
    expect(unload().defaultPrevented).toBe(false);
  });

  it('unsaved text: kept as a draft and the browser asks', () => {
    const s = new NoteSaver('C.md', 'v0', api, storage, { content: '' });
    s.edit('ungespeichert');
    expect(unload().defaultPrevented).toBe(true);
    expect(readDraft(storage, 'C.md')?.content).toBe('ungespeichert');
    s.close();
  });

  it('the reload of a language change never asks (it could be cancelled), but keeps the draft', () => {
    vi.mocked(i18n.isLanguageReload).mockReturnValue(true);
    try {
      const s = new NoteSaver('D.md', 'v0', api, storage, { content: '' });
      s.edit('ungespeichert');
      expect(unload().defaultPrevented).toBe(false);
      expect(readDraft(storage, 'D.md')?.content).toBe('ungespeichert');
      s.close();
    } finally {
      vi.mocked(i18n.isLanguageReload).mockReturnValue(false);
    }
  });
});

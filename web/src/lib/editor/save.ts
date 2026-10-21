import { ApiError, type ConflictBody } from '../api';
import { isAtOrBelow, movePath } from '../tree';

/** What the saver needs from `api.note` (injectable for tests). */
export interface NoteApi {
  get(path: string): Promise<{ content: string; version: string; readonly: boolean }>;
  save(path: string, content: string, baseVersion: string): Promise<{ version: string }>;
  create(path: string, content: string): Promise<{ path: string; version: string }>;
}

/** `offline`: network/server trouble or logged out, retried; `error`: the server refused the text (e.g. too big), not retried automatically. */
export type SaverState = 'saved' | 'dirty' | 'saving' | 'conflict' | 'offline' | 'error';

export interface Conflict {
  /** The text in the editor. */
  mine: string;
  /** `null`: the file no longer exists on disk. */
  diskContent: string | null;
  diskVersion: string | null;
}

/** Unsaved text kept in localStorage (`vw-draft:<path>`) while saving is impossible (offline, logged out). */
export interface Draft {
  content: string;
  /** The disk version the text was based on; `null` when the note did not exist. */
  baseVersion: string | null;
  savedAt: number;
}

export interface SaverOptions {
  /** The text on disk at `version`. */
  content?: string;
  readonly?: boolean;
  /** The editor must show this text (external change reloaded, conflict resolved to the disk version). */
  onReload?: (content: string) => void;
  /** `state`, `conflict` or `deleted` changed. */
  onUpdate?: () => void;
}

export const DEBOUNCE_MS = 800;
/** Retry delays after network errors; the last one repeats. */
const RETRY_MS = [2000, 5000, 10_000, 30_000];
/** Client errors that will not go away by retrying (unlike 408 timeout / 429 rate limit). */
const isPermanent = (err: unknown) =>
  err instanceof ApiError && err.status >= 400 && err.status < 500 && ![401, 408, 409, 429].includes(err.status);
/** Versions produced by our own saves, recognised when their events come back. */
const OWN_VERSIONS_MAX = 50;
const MAX_COPY_ATTEMPTS = 20;

/** Savers of the notes open right now (for the warning when leaving the page). */
const openSavers = new Set<NoteSaver>();
/** Closed savers still finishing their last save (they follow renames too). */
const closingSavers = new Set<NoteSaver>();

/** Some open note has text that is not on disk yet (unsaved, saving, offline or in conflict). */
export function hasUnsavedNotes(): boolean {
  return [...openSavers].some((s) => s.unsaved);
}

/** The page is unloading: store every open note's unsaved text as a draft. */
export function keepAllDrafts(): void {
  for (const s of openSavers) s.keepDraft();
}

/**
 * Before an in-app rename/move of `path` (file or folder): save the open notes at or below it, so no
 * pending edit is sent to the old path afterwards. Failures are fine: the text stays in the saver and draft.
 */
export async function flushSaversUnder(path: string): Promise<void> {
  await Promise.all([...openSavers].filter((s) => isAtOrBelow(s.path, path)).map((s) => s.flush().catch(() => {})));
}

/**
 * `from` was renamed to `to` (file or folder): open savers follow (their next save goes to the new path) and
 * stored drafts move along. Call before the workspace remounts the views.
 */
export function applyRename(from: string, to: string, storage: Storage = draftStorage()): void {
  for (const s of openSavers) if (isAtOrBelow(s.path, from)) s.retarget(movePath(s.path, from, to));
  for (const saver of closingSavers) if (isAtOrBelow(saver.path, from)) saver.retarget(movePath(saver.path, from, to));
  const moves: [string, string][] = [];
  try {
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (!key?.startsWith(DRAFT_PREFIX)) continue;
      const p = key.slice(DRAFT_PREFIX.length);
      if (isAtOrBelow(p, from)) moves.push([key, draftKey(movePath(p, from, to))]);
    }
    for (const [oldKey, newKey] of moves) {
      const value = storage.getItem(oldKey);
      if (value === null) continue;
      // An existing draft at the target is not overwritten (never drop text): the moved one keeps its old key.
      if (storage.getItem(newKey) !== null) continue;
      storage.setItem(newKey, value);
      storage.removeItem(oldKey);
    }
  } catch {
    /* storage blocked */
  }
}

let memoryStorage: Storage | undefined;

/** localStorage, or (blocked, private mode) one shared memory stand-in: drafts then only live as long as the page. */
export function draftStorage(): Storage {
  try {
    const ls = globalThis.localStorage;
    if (ls) return ls;
  } catch {
    /* blocked */
  }
  if (memoryStorage) return memoryStorage;
  const map = new Map<string, string>();
  return (memoryStorage = {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k) => map.get(k) ?? null,
    key: (i) => [...map.keys()][i] ?? null,
    removeItem: (k) => void map.delete(k),
    setItem: (k, v) => void map.set(k, String(v)),
  });
}

const DRAFT_PREFIX = 'vw-draft:';
const draftKey = (path: string) => `${DRAFT_PREFIX}${path}`;

export function readDraft(storage: Storage, path: string): Draft | null {
  try {
    const raw = storage.getItem(draftKey(path));
    if (!raw) return null;
    const d = JSON.parse(raw) as Partial<Draft>;
    if (typeof d.content !== 'string' || (typeof d.baseVersion !== 'string' && d.baseVersion !== null)) return null;
    return { content: d.content, baseVersion: d.baseVersion, savedAt: Number(d.savedAt) || 0 };
  } catch {
    return null;
  }
}

function writeDraft(storage: Storage, path: string, draft: Draft): void {
  try {
    storage.setItem(draftKey(path), JSON.stringify(draft));
  } catch {
    /* storage full or blocked: the text stays in the editor */
  }
}

function removeDraft(storage: Storage, path: string): void {
  try {
    storage.removeItem(draftKey(path));
  } catch {
    /* blocked */
  }
}

const pad = (n: number) => String(n).padStart(2, '0');

/** `Ordner/Name.md` → `Ordner/Name (Konflikt 2026-10-20 1407).md` (local time); `n` > 1 appends ` n`. */
export function conflictCopyPath(path: string, at: Date, n = 1): string {
  const dot = path.toLowerCase().endsWith('.md') ? path.length - 3 : path.length;
  const stamp = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}${pad(at.getMinutes())}`;
  return `${path.slice(0, dot)} (Konflikt ${stamp})${n > 1 ? ` ${n}` : ''}${path.slice(dot)}`;
}

const isConflict = (err: unknown): err is ApiError & { body: ConflictBody } =>
  err instanceof ApiError && err.status === 409 && typeof err.body === 'object' && err.body !== null && 'diskVersion' in err.body;

/**
 * Saves one note: debounced, serialized (never two PUTs in flight; the next PUT builds on the version the
 * previous one returned), with conflict detection, drafts in `storage` and retries when offline.
 * Data safety first: text is never dropped silently and never written over a version it was not based on.
 */
export class NoteSaver {
  private _path: string;
  /** Why the server refused the last save (state `error`). */
  errorMessage = '';
  /** The last known disk version our `savedText` matches; `null` = the file does not exist (create on save). */
  version: string | null;
  /** The editor's text. */
  text: string;
  /** The text on disk at `version`; `null`: nothing of ours is on disk (the text must be written). */
  private savedText: string | null;
  private _state: SaverState = 'saved';
  private _conflict: Conflict | null = null;
  private _deleted = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private retries = 0;
  private inFlight: Promise<void> | null = null;
  private ownVersions: string[] = [];
  private closed = false;
  private readonly readonly: boolean;

  constructor(
    path: string,
    version: string | null,
    private readonly api: NoteApi,
    private readonly storage: Storage,
    private readonly opts: SaverOptions = {},
  ) {
    this._path = path;
    this.version = version;
    this.text = this.savedText = opts.content ?? '';
    this.readonly = opts.readonly ?? false;
    openSavers.add(this);
  }

  get path(): string {
    return this._path;
  }

  /** The note was renamed: later saves (and drafts) use the new path. */
  retarget(path: string): void {
    if (path === this._path) return;
    const hadDraft = readDraft(this.storage, this._path);
    if (hadDraft && !readDraft(this.storage, path)) {
      writeDraft(this.storage, path, hadDraft);
      removeDraft(this.storage, this._path);
    }
    this._path = path;
  }

  get state(): SaverState {
    return this._state;
  }
  get conflict(): Conflict | null {
    return this._conflict;
  }
  /** The file was deleted on disk: nothing is saved until `saveAsNew()`. */
  get deleted(): boolean {
    return this._deleted;
  }
  /** Text that is not on disk yet. */
  get unsaved(): boolean {
    return !this.readonly && (this.savedText === null || this.text !== this.savedText);
  }

  private set(state: SaverState): void {
    this._state = state;
    if (!this.closed) this.opts.onUpdate?.();
  }

  /** New editor text; saved 800 ms after the last edit. */
  edit(text: string): void {
    this.text = text;
    if (this.readonly) return;
    if (this._conflict) {
      this._conflict = { ...this._conflict, mine: text };
      this.storeDraft();
      return;
    }
    if (this._state === 'offline') {
      this.storeDraft();
      return;
    }
    if (this._state === 'error') {
      // The refused text may be fixed by editing (e.g. made smaller): try again after the pause.
      this.storeDraft();
      clearTimeout(this.timer);
      this.timer = setTimeout(() => void this.flush(), DEBOUNCE_MS);
      return;
    }
    if (this._state === 'saving') return; // the running save's loop picks it up
    if (!this.unsaved) {
      clearTimeout(this.timer);
      this.set('saved');
      return;
    }
    this.set('dirty');
    clearTimeout(this.timer);
    if (!this._deleted) this.timer = setTimeout(() => void this.flush(), DEBOUNCE_MS);
  }

  /** Saves now (also retries when offline, e.g. after a new login) and waits until everything is on disk or failed. */
  async flush(): Promise<void> {
    clearTimeout(this.timer);
    clearTimeout(this.retryTimer);
    for (;;) {
      if (this.inFlight) {
        await this.inFlight;
        if (this._state === 'offline' || this._state === 'error' || this._conflict) return;
        continue;
      }
      if (this._conflict || this.readonly) return;
      if (this._deleted) {
        if (this._state === 'saving') this.set(this.unsaved ? 'dirty' : 'saved');
        return;
      }
      if (!this.unsaved) {
        this.retries = 0;
        removeDraft(this.storage, this.path);
        this.set('saved');
        return;
      }
      this.inFlight = this.put().finally(() => (this.inFlight = null));
    }
  }

  private async put(): Promise<void> {
    const content = this.text;
    const base = this.version;
    this.set('saving');
    try {
      const version = base === null ? (await this.api.create(this.path, content)).version : (await this.api.save(this.path, content, base)).version;
      this.rememberOwn(version);
      // Deleted meanwhile (the event overtook this answer): the file is gone, `version` stays null.
      if (!this._deleted) this.version = version;
      this.savedText = content;
      this.retries = 0;
      this.errorMessage = '';
      // A conflict found meanwhile (external change) stays until the user decides.
      if (this._conflict) return;
      if (!this.unsaved) {
        removeDraft(this.storage, this.path);
        this.set('saved');
      }
    } catch (err) {
      if (isConflict(err)) {
        if (this._deleted && err.body.diskVersion === null) {
          // Deleted on disk and known as such: the banner offers "save as new", no dialog needed.
          this.storeDraft();
          this.set(this.unsaved ? 'dirty' : 'saved');
        } else this.enterConflict(err.body.diskContent, err.body.diskVersion);
        return;
      }
      this.storeDraft();
      if (this._conflict) return; // the conflict (and its dialog) stays; the text is in the draft too
      if (isPermanent(err)) {
        this.errorMessage = (err as Error).message;
        this.set('error');
        return;
      }
      this.set('offline');
      // Logged out: retry after the new login (flush). Otherwise (network, server error) retry with backoff.
      if (!(err instanceof ApiError && err.status === 401)) this.scheduleRetry();
    }
  }

  private scheduleRetry(): void {
    if (this.closed) return;
    const delay = RETRY_MS[Math.min(this.retries, RETRY_MS.length - 1)]!;
    this.retries++;
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => void this.flush(), delay);
  }

  private rememberOwn(version: string): void {
    this.ownVersions.push(version);
    if (this.ownVersions.length > OWN_VERSIONS_MAX) this.ownVersions.shift();
  }

  private storeDraft(): void {
    if (this.unsaved) writeDraft(this.storage, this.path, { content: this.text, baseVersion: this.version, savedAt: Date.now() });
  }

  /** Mine vs. disk. When both are the same text there is nothing to decide: the disk version is adopted. */
  private enterConflict(diskContent: string | null, diskVersion: string | null): void {
    clearTimeout(this.timer);
    clearTimeout(this.retryTimer);
    if (diskContent !== null && diskVersion !== null && diskContent === this.text) {
      this._conflict = null;
      this._deleted = false;
      this.version = diskVersion;
      this.savedText = diskContent;
      this.retries = 0;
      removeDraft(this.storage, this.path);
      this.set('saved');
      return;
    }
    this._conflict = { mine: this.text, diskContent, diskVersion };
    this.storeDraft();
    this.set('conflict');
  }

  /** Takes over the disk text (now shown in the editor). */
  private loadDisk(content: string | null, version: string | null): void {
    clearTimeout(this.timer);
    clearTimeout(this.retryTimer);
    this._conflict = null;
    this._deleted = version === null;
    this.version = version;
    this.text = this.savedText = content ?? '';
    removeDraft(this.storage, this.path);
    if (!this.closed) this.opts.onReload?.(this.text);
    this.set('saved');
  }

  /**
   * A `changed`/`created` event for this note. Our own saves come back as events too: their versions are
   * recognised (also when the event overtakes the PUT answer). A real external change reloads a clean
   * note and is a conflict when there is unsaved text.
   */
  async onExternalChange(version: string): Promise<'reloaded' | 'conflict' | 'ignored'> {
    const known = () => version === this.version || this.ownVersions.includes(version);
    // An echo can overtake the answer of the PUT that caused it: wait for running saves until it is recognised.
    while (!known() && this.inFlight) await this.inFlight;
    if (known()) return 'ignored';
    if (this._conflict || this.unsaved) {
      let disk: { content: string; version: string };
      try {
        disk = await this.api.get(this.path);
      } catch (err) {
        // Not readable now (offline, server error, logged out): no "deleted" conflict on a guess.
        // A real deletion arrives as its own event; otherwise the retried save answers 409 with the disk text.
        if (this._conflict) return 'conflict';
        this.storeDraft();
        this.set('offline');
        if (!(err instanceof ApiError && err.status === 401)) this.scheduleRetry();
        return 'ignored';
      }
      this.enterConflict(disk.content, disk.version);
      return this._conflict ? 'conflict' : 'reloaded';
    }
    const before = this.text;
    let disk: { content: string; version: string };
    try {
      disk = await this.api.get(this.path);
    } catch {
      return 'ignored'; // unreadable (gone again, offline): the next event or save sorts it out
    }
    if (disk.version === this.version) return 'ignored';
    if (this.text !== before || this._conflict) {
      // Typed while the new text was on its way: keep the typing, let the user decide.
      this.enterConflict(disk.content, disk.version);
      return this._conflict ? 'conflict' : 'reloaded';
    }
    this.loadDisk(disk.content, disk.version);
    return 'reloaded';
  }

  /** The file was deleted on disk. A clean note just stops; unsaved text stays in the editor. */
  markDeleted(): void {
    clearTimeout(this.timer);
    clearTimeout(this.retryTimer);
    this._deleted = true;
    this.version = null;
    // A running save finishes on its own (flush settles the state); otherwise nothing is pending anymore.
    if (!this.inFlight && this._state !== 'conflict' && this._state !== 'offline' && this._state !== 'error')
      this._state = this.unsaved ? 'dirty' : 'saved';
    if (!this.closed) this.opts.onUpdate?.();
  }

  /** Recreates the deleted note at its path with the editor's text (a conflict if the path is taken meanwhile). */
  async saveAsNew(): Promise<void> {
    this._deleted = false;
    this.version = null;
    this.savedText = null;
    await this.flush();
  }

  /** Decides a conflict. Throws (and stays in conflict) when the server cannot be reached. */
  async resolve(choice: 'mine' | 'disk' | 'both'): Promise<void> {
    const c = this._conflict;
    if (!c) return;
    if (choice === 'mine') {
      this._conflict = null;
      this._deleted = false;
      this.version = c.diskVersion;
      this.savedText = c.diskContent;
      this.text = c.mine;
      this.set('dirty');
      await this.flush();
      return;
    }
    if (choice === 'both') await this.createCopy(c.mine);
    this.loadDisk(c.diskContent, c.diskVersion);
  }

  private async createCopy(content: string): Promise<void> {
    const at = new Date();
    for (let n = 1; n <= MAX_COPY_ATTEMPTS; n++) {
      try {
        const created = await this.api.create(conflictCopyPath(this.path, at, n), content);
        this.rememberOwn(created.version);
        return;
      } catch (err) {
        if (!(err instanceof ApiError && err.status === 409)) throw err;
      }
    }
    throw new Error('Kein freier Name für die Konfliktkopie');
  }

  /**
   * On opening: a stored draft on the same disk version becomes the editor's (unsaved) text; one on
   * another version is a conflict (draft vs. disk). Returns what happened.
   */
  restoreDraft(): 'none' | 'restored' | 'conflict' {
    const draft = readDraft(this.storage, this.path);
    if (!draft) return 'none';
    if (draft.content === this.savedText || this.readonly) {
      if (draft.content === this.savedText) removeDraft(this.storage, this.path);
      return 'none';
    }
    if (draft.baseVersion === this.version) {
      this.edit(draft.content);
      return 'restored';
    }
    this.text = draft.content;
    this.enterConflict(this.savedText, this.version);
    return this._conflict ? 'conflict' : 'none';
  }

  /** Stores unsaved text as a draft right away (page is unloading). */
  keepDraft(): void {
    if (this.unsaved) this.storeDraft();
  }

  /** The view goes away: unsaved text is kept as a draft and saved one last time (the draft goes on success). */
  close(): void {
    this.keepDraft();
    this.closed = true;
    openSavers.delete(this);
    clearTimeout(this.retryTimer);
    closingSavers.add(this);
    void this.flush().finally(() => closingSavers.delete(this));
  }
}

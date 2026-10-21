import { randomBytes } from 'node:crypto';
import { mkdir, open, rename, stat, unlink, writeFile } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { basename, dirname, join } from 'node:path';

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Deep copy of JSON-compatible data. */
const clone = <T>(v: T): T => structuredClone(v);

/** Keys that could reach `Object.prototype` (or a constructor) when assigned; never merged. */
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

const kindOf = (v: unknown): string => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);

/** Identity of a file version: rename-based writes always change `ino`, edits change mtime/size. */
type Stamp = { ino: number; mtimeMs: number; size: number } | null;
const stampOf = (st: Stats): Stamp => ({ ino: st.ino, mtimeMs: st.mtimeMs, size: st.size });
const sameStamp = (a: Stamp, b: Stamp): boolean =>
  a === b || (a !== null && b !== null && a.ino === b.ino && a.mtimeMs === b.mtimeMs && a.size === b.size);

/** Deep-merges `stored` over `defaults`: stored values win, arrays are replaced, missing keys come from defaults. */
function mergeOver(defaults: unknown, stored: unknown): unknown {
  if (isPlainObject(defaults) && isPlainObject(stored)) {
    const out: Record<string, unknown> = clone(defaults);
    for (const [k, v] of Object.entries(stored)) {
      if (UNSAFE_KEYS.has(k)) continue;
      out[k] = Object.hasOwn(out, k) ? mergeOver(out[k], v) : v;
    }
    return out;
  }
  return stored;
}

/**
 * JSON file with defaults, atomic writes (temp file in the same directory + rename),
 * mode 0600 (directory 0700 when created) and serialized updates. A corrupt file or one whose
 * top-level type differs from the defaults is an error, never silently replaced.
 * All returned values are deep copies; callers can never mutate the stored state.
 *
 * Several processes may use the same file (server and CLI via `docker exec`): `update()` and
 * `refresh()` re-read the file when it changed since this instance last read or wrote it
 * (one `stat`). `get()` is synchronous and returns the state as of the last load/refresh/update,
 * so callers that need the current file content call `refresh()` first.
 */
export class JsonStore<T> {
  private current: T;
  private loaded = false;
  /** Version of the file this instance last read or wrote; `null` = file did not exist. */
  private stamp: Stamp = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly file: string,
    private readonly defaults: T,
  ) {
    this.current = clone(defaults);
  }

  async load(): Promise<T> {
    let raw: string;
    let stamp: Stamp;
    try {
      const fh = await open(this.file, 'r');
      try {
        stamp = stampOf(await fh.stat());
        raw = await fh.readFile('utf8');
      } finally {
        await fh.close();
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      this.current = clone(this.defaults);
      this.stamp = null;
      this.loaded = true;
      return clone(this.current);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error(
        `Datei ${this.file} enthält ungültiges JSON und wird nicht überschrieben: ${(err as Error).message}`,
      );
    }
    if (kindOf(parsed) !== kindOf(this.defaults)) {
      throw new Error(
        `Datei ${this.file} hat ein unerwartetes Format (${kindOf(parsed)} statt ${kindOf(this.defaults)}) und wird nicht überschrieben`,
      );
    }
    this.current = mergeOver(this.defaults, parsed) as T;
    this.stamp = stamp;
    this.loaded = true;
    return clone(this.current);
  }

  /** Re-reads the file if another writer changed (or removed) it. Serialized with updates. */
  refresh(): Promise<void> {
    const result = this.queue.then(() => this.reloadIfChanged());
    this.queue = result.catch(() => undefined);
    return result;
  }

  private async reloadIfChanged(): Promise<void> {
    if (!this.loaded) {
      await this.load();
      return;
    }
    let now: Stamp;
    try {
      now = stampOf(await stat(this.file));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      now = null;
    }
    if (!sameStamp(now, this.stamp)) await this.load();
  }

  get(): T {
    return clone(this.current);
  }

  /** `fn` may mutate the given copy or return a new value. Updates run one after another. */
  update(fn: (t: T) => T | void): Promise<T> {
    const run = async (): Promise<T> => {
      await this.reloadIfChanged();
      const draft = clone(this.current);
      const next = (fn(draft) ?? draft) as T;
      await this.write(next);
      this.current = clone(next);
      return next;
    };
    const result = this.queue.then(run);
    this.queue = result.catch(() => undefined);
    return result;
  }

  private async write(value: T): Promise<void> {
    const dir = dirname(this.file);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const tmp = join(dir, `${basename(this.file)}.${randomBytes(6).toString('hex')}.tmp`);
    try {
      await writeFile(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
      // rename keeps inode, mtime and size, so this is the stamp of the new file version.
      const written = stampOf(await stat(tmp));
      await rename(tmp, this.file);
      this.stamp = written;
    } catch (err) {
      await unlink(tmp).catch(() => undefined);
      throw err;
    }
  }
}

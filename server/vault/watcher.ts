import { createHash } from 'node:crypto';
import path from 'node:path';
import chokidar, { type FSWatcher } from 'chokidar';
import type { EventBus } from '../events';
import type { SearchIndex } from '../index/search';
import type { VaultIndex } from '../index/vault-index';
import type { Version, VaultFiles } from './files';
import { PathError, normalizeRel, type VaultPaths } from './paths';

export interface WatcherDeps {
  /** Absoluter Vault-Pfad (wie bei VaultPaths). */
  root: string;
  paths: VaultPaths;
  files: VaultFiles;
  index: VaultIndex;
  search: SearchIndex;
  bus: EventBus;
  /** Uhr für das Ablaufen der Markierungen (Tests). */
  now?: () => number;
  /** Logger (pino-kompatibel) für nicht lesbare Dateien und Start-Probleme. */
  log?: WatcherLog;
  /** Höchstdauer bis `ready` des Dateisystem-Watchers (Standard 60 s). */
  readyTimeoutMs?: number;
}

export interface WatcherLog {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

/** Fehler, die nur heißen „Datei ist (inzwischen) weg oder ein Ordner“ – kein Log. */
const SILENT_ERRNO = new Set(['ENOENT', 'ENOTDIR', 'EISDIR']);
const DEFAULT_READY_TIMEOUT_MS = 60_000;

const CONCURRENCY = 16;
/** Markierungen eigener Schreib-/Verschiebevorgänge verfallen nach dieser Zeit. */
const MARK_TTL_MS = 10_000;
const isNote = (p: string) => p.toLowerCase().endsWith('.md');

/** Hält Index und Suche aktuell und meldet externe Änderungen als Ereignisse. */
export class VaultWatcher {
  private watcher: FSWatcher | undefined;
  /** Zuletzt bekannte Version je kanonischem Pfad. */
  private readonly versions = new Map<string, Version>();
  /** Eigene Schreibvorgänge, deren Ereignis unterdrückt wird. */
  private readonly own = new Map<string, { version: Version; expires: number }>();
  /** Eigene Verschiebungen (Datei oder Ordner): deleted(from…)/created(to…) werden unterdrückt. */
  private moves: { from: string; to: string; expires: number }[] = [];
  /** Je Pfad serialisiert, damit schnelle Folgeereignisse in Reihenfolge laufen. */
  private readonly chains = new Map<string, Promise<void>>();
  private stopped = false;
  /** Pfade, deren Lesefehler schon geloggt wurde (je Pfad nur einmal). */
  private readonly loggedErrors = new Set<string>();

  constructor(private readonly deps: WatcherDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  markOwnWrite(p: string, version: Version): void {
    this.own.set(normalizeRel(p), { version, expires: this.now() + MARK_TTL_MS });
  }

  /** Eigene Verschiebung: Index wird weiter aktualisiert, aber ohne deleted/created-Ereignisse. */
  markOwnMove(from: string, to: string): void {
    const now = this.now();
    this.moves = this.moves.filter((m) => m.expires > now);
    this.moves.push({ from: normalizeRel(from), to: normalizeRel(to), expires: now + MARK_TTL_MS });
  }

  /** Nimmt eine Markierung von `markOwnMove` zurück (Verschieben gescheitert). */
  unmarkOwnMove(from: string, to: string): void {
    const f = normalizeRel(from);
    const t = normalizeRel(to);
    const i = this.moves.findIndex((m) => m.from === f && m.to === t);
    if (i >= 0) this.moves.splice(i, 1);
  }

  private isOwnMove(rel: string, side: 'from' | 'to'): boolean {
    const now = this.now();
    return this.moves.some((m) => m.expires > now && (rel === m[side] || rel.startsWith(m[side] + '/')));
  }

  async start(): Promise<void> {
    const root = path.resolve(this.deps.root);
    this.stopped = false;
    const w = chokidar.watch(root, {
      ignoreInitial: true,
      persistent: true,
      followSymlinks: false,
      awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
      ignored: (p: string) => this.isIgnored(root, p),
    });
    this.watcher = w;
    w.on('add', (p) => this.enqueue(root, p, 'upsert'));
    w.on('change', (p) => this.enqueue(root, p, 'upsert'));
    w.on('unlink', (p) => this.enqueue(root, p, 'remove'));
    w.on('unlinkDir', (p) => this.enqueue(root, p, 'removeDir'));
    w.on('error', (err) => {
      // einzelne Dateisystemfehler (z. B. EACCES) dürfen den Wächter nicht beenden
      this.deps.log?.warn({ err }, 'Dateisystem-Watcher meldet einen Fehler');
    });
    const timeoutMs = this.deps.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        new Promise<void>((resolve) => w.once('ready', () => resolve())),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`Vault-Watcher nicht bereit nach ${Math.round(timeoutMs / 1000)} s (VAULT_DIR ${root} prüfen)`)),
            timeoutMs,
          );
        }),
      ]);
    } catch (err) {
      this.deps.log?.error({ err }, 'Vault-Watcher startet nicht');
      await this.stop();
      throw err;
    } finally {
      clearTimeout(timer);
    }
    const count = await this.initialIndex();
    this.deps.log?.info(
      { files: count, uid: process.getuid?.(), gid: process.getgid?.() },
      'Vault indiziert',
    );
  }

  async stop(): Promise<void> {
    this.stopped = true;
    const w = this.watcher;
    this.watcher = undefined;
    await w?.close();
    await Promise.allSettled([...this.chains.values()]);
  }

  private toRel(root: string, abs: string): string | undefined {
    const r = path.relative(root, abs);
    if (r.startsWith('..') || path.isAbsolute(r)) return undefined;
    try {
      return normalizeRel(r.split(path.sep).join('/'));
    } catch {
      return undefined;
    }
  }

  private isIgnored(root: string, abs: string): boolean {
    const rel = this.toRel(root, abs);
    if (rel === undefined) return true;
    if (rel === '') return false;
    try {
      return !this.deps.paths.isVisible(rel);
    } catch (e) {
      if (e instanceof PathError) return true;
      throw e;
    }
  }

  /** Indiziert alle sichtbaren Dateien; liefert die Anzahl der erfolgreich indizierten. */
  private async initialIndex(): Promise<number> {
    const tree = await this.deps.files.tree();
    const list: string[] = [];
    const walk = (e: typeof tree) => {
      for (const c of e.children ?? []) {
        if (c.kind === 'folder') walk(c);
        else list.push(c.path);
      }
    };
    walk(tree);
    let next = 0;
    let indexed = 0;
    const worker = async () => {
      while (next < list.length) {
        const p = list[next++]!;
        if ((await this.indexFile(p).catch(() => undefined)) !== undefined) indexed++;
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, list.length) }, worker));
    return indexed;
  }

  /** Liest die Datei, aktualisiert Index/Suche und liefert die Version (undefined, wenn nicht lesbar). */
  private async indexFile(rel: string): Promise<Version | undefined> {
    const { files, index, search } = this.deps;
    try {
      let version: Version;
      if (isNote(rel)) {
        // Verlustbehaftet ist hier in Ordnung: der Index schreibt nie zurück.
        const r = await files.read(rel, { lossy: true });
        version = r.version;
        index.upsert(rel, r.content);
        search.upsert(rel, r.content, [...new Set((index.note(rel)?.tags ?? []).map((t) => t.tag))]);
      } else {
        const { stream } = await files.readBytes(rel);
        const h = createHash('sha256');
        for await (const chunk of stream) h.update(chunk as Buffer);
        version = h.digest('hex');
        index.addFile(rel);
      }
      this.versions.set(rel, version);
      this.loggedErrors.delete(rel);
      return version;
    } catch (e) {
      // Datei verschwunden, Ordner, verbotener Pfad: still ignorieren (unlink-Ereignis folgt ggf.)
      if (e instanceof PathError || (e as Error).name === 'NotAFileError') return undefined;
      const code = (e as NodeJS.ErrnoException).code;
      if (code) {
        // EACCES/EIO/EMFILE …: Datei fehlt sonst still in Suche/Graph (z. B. falsche PUID).
        if (!SILENT_ERRNO.has(code) && !this.loggedErrors.has(rel)) {
          this.loggedErrors.add(rel);
          this.deps.log?.warn({ path: rel, code }, 'Datei nicht lesbar, nicht im Index');
        }
        return undefined;
      }
      throw e;
    }
  }

  private enqueue(root: string, abs: string, kind: 'upsert' | 'remove' | 'removeDir'): void {
    if (this.stopped) return;
    const rel = this.toRel(root, abs);
    if (!rel) return;
    const prev = this.chains.get(rel) ?? Promise.resolve();
    const run = prev.then(() => (kind === 'upsert' ? this.onUpsert(rel) : kind === 'remove' ? this.onRemove(rel) : this.onRemoveDir(rel))).catch(() => undefined);
    this.chains.set(rel, run);
    void run.then(() => {
      if (this.chains.get(rel) === run) this.chains.delete(rel);
    });
  }

  private async onUpsert(rel: string): Promise<void> {
    const known = this.versions.get(rel);
    const version = await this.indexFile(rel);
    if (version === undefined || this.stopped) return;
    const own = this.own.get(rel);
    if (own !== undefined && (own.version === version || own.expires <= this.now())) {
      this.own.delete(rel);
      if (own.version === version && own.expires > this.now()) return;
    }
    if (known === version) return;
    if (known === undefined && this.isOwnMove(rel, 'to')) return;
    this.deps.bus.publish({ type: known === undefined ? 'created' : 'changed', path: rel, version });
  }

  private onRemove(rel: string): void {
    if (this.removeOne(rel) && !this.stopped && !this.isOwnMove(rel, 'from')) this.deps.bus.publish({ type: 'deleted', path: rel });
  }

  private onRemoveDir(rel: string): void {
    const prefix = rel + '/';
    for (const p of [...this.versions.keys()]) {
      if (p.startsWith(prefix)) this.onRemove(p);
    }
  }

  private removeOne(rel: string): boolean {
    if (!this.versions.delete(rel)) return false;
    this.own.delete(rel);
    this.deps.index.remove(rel);
    this.deps.search.remove(rel);
    return true;
  }
}

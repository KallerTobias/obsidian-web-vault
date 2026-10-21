import { link, lstat, mkdir, readdir, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { basename, dirname, nfc } from '@shared/normalize';
import { parseNote } from '@shared/parse';
import { resolveLink } from '@shared/resolve';
import { rewriteLinks } from '@shared/rewrite';
import type { LinkRef } from '@shared/types';
import type { EventBus } from '../events';
import type { VaultIndex } from '../index/vault-index';
import { ConflictError, NotAFileError, NotUtf8Error, type VaultFiles, type Version } from './files';
import { PathError, normalizeRel, type VaultPaths } from './paths';

/** Der Teil des Watchers, den VaultOps braucht (Tests geben eine Attrappe). */
export interface OwnChangeMarker {
  markOwnWrite(p: string, version: Version): void;
  markOwnMove(from: string, to: string): void;
  /** Nimmt eine Markierung zurück, wenn das Verschieben gescheitert ist. */
  unmarkOwnMove(from: string, to: string): void;
}

export interface VaultOpsDeps {
  paths: VaultPaths;
  files: VaultFiles;
  index: VaultIndex;
  bus: EventBus;
  watcher: OwnChangeMarker;
}

export interface RenameResult {
  /** Jede verschobene (indizierte) Datei; bei Ordnern alle enthaltenen Dateien. */
  moved: { from: string; to: string }[];
  /** Notizen (neue Pfade), deren Links angepasst wurden. */
  updated: string[];
  /** Verlinkende Notizen in schreibgeschützten Bereichen; nicht angepasst. */
  skippedReadonly: string[];
  /** Notizen, die sich zwischen Lesen und Schreiben extern geändert haben; nicht überschrieben. */
  conflicts: string[];
  /** Notizen, die aus anderen Gründen nicht geschrieben werden konnten (z. B. EACCES); unverändert. */
  failed: string[];
}

/** Das Ziel einer Umbenennung existiert schon; es wurde nichts verändert. */
export class TargetExistsError extends ConflictError {
  constructor() {
    super(null, null);
    this.message = 'Ziel existiert bereits';
    this.name = 'TargetExistsError';
  }
}

interface Snapshot {
  path: string;
  content: string;
  version: Version;
  links: LinkRef[];
  resolved: (string | null)[];
}

const TRASH = '.trash';
const isNote = (p: string) => p.toLowerCase().endsWith('.md');
const isErrno = (e: unknown, ...codes: string[]) => codes.includes((e as NodeJS.ErrnoException)?.code ?? '');

async function existsAbs(abs: string): Promise<boolean> {
  try {
    await lstat(abs);
    return true;
  } catch (e) {
    if (isErrno(e, 'ENOENT', 'ENOTDIR')) return false;
    throw e;
  }
}

/** Verschiebt ohne je ein bestehendes Ziel zu ersetzen (Dateien per link+unlink, Ordner per rename). */
async function moveNoReplace(fromAbs: string, toAbs: string, isDir: boolean): Promise<void> {
  if (isDir) {
    try {
      await rename(fromAbs, toAbs); // scheitert an einem nicht-leeren Zielordner
    } catch (e) {
      if (isErrno(e, 'EEXIST', 'ENOTEMPTY', 'ENOTDIR')) throw new TargetExistsError();
      throw e;
    }
    return;
  }
  try {
    await link(fromAbs, toAbs); // atomar, scheitert bei Existenz
  } catch (e) {
    if (isErrno(e, 'EEXIST')) throw new TargetExistsError();
    if (!isErrno(e, 'EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS')) throw e;
    // Dateisystem ohne Hardlinks: kleines Restfenster zwischen Prüfung und rename
    if (await existsAbs(toAbs)) throw new TargetExistsError();
    await rename(fromAbs, toAbs);
    return;
  }
  await unlink(fromAbs);
}

/** Umbenennen/Verschieben mit Link-Anpassung und Papierkorb. Vorgänge laufen nacheinander. */
export class VaultOps {
  private tail: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: VaultOpsDeps) {}

  rename(from: string, to: string, updateLinks: boolean): Promise<RenameResult> {
    return this.serial(() => this.doRename(from, to, updateLinks));
  }

  trash(p: string): Promise<void> {
    return this.serial(() => this.doTrash(p));
  }

  /** Notizen, die auf `from` (Datei) oder etwas darin (Ordner) verlinken. */
  affectedBy(from: string): string[] {
    const sources = new Set<string>();
    for (const p of this.indexedUnder(normalizeRel(from))) {
      for (const b of this.deps.index.backlinks(p)) sources.add(b.source);
    }
    return [...sources].sort();
  }

  // --- internals ---

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.tail.then(fn, fn);
    this.tail = run.catch(() => undefined);
    return run;
  }

  /** Indizierte Pfade gleich `p` oder darunter. */
  private indexedUnder(p: string): string[] {
    const out: string[] = [];
    for (const x of this.deps.index.lookup().byPath.values()) {
      if (x === p || x.startsWith(p + '/')) out.push(x);
    }
    return out.sort();
  }

  /** Kanonischer, beschreibbarer Pfad (nicht Wurzel, versteckt, ausgeschlossen, schreibgeschützt). */
  private writable(rel: string): string {
    const clean = normalizeRel(rel);
    const { paths } = this.deps;
    if (clean === '') throw new PathError('OUTSIDE', 'Die Vault-Wurzel kann nicht verändert werden');
    if (paths.isHidden(clean)) throw new PathError('HIDDEN', 'Versteckter Pfad');
    if (paths.isExcluded(clean)) throw new PathError('EXCLUDED', 'Pfad ist ausgeschlossen');
    if (paths.isReadonly(clean)) throw new PathError('READONLY', 'Pfad ist schreibgeschützt');
    return clean;
  }

  /**
   * Quelle auflösen. Bei Ordnern wird der Inhalt auf der Platte geprüft (auch nicht Indiziertes):
   * nichts darin darf ausgeschlossen oder schreibgeschützt sein, und mit `to` darf auch kein
   * Zielpfad versteckt, ausgeschlossen oder schreibgeschützt werden. Dotfiles wandern unbesehen mit.
   */
  private async source(clean: string, to: string | null): Promise<{ abs: string; isDir: boolean }> {
    const { paths } = this.deps;
    const abs = await paths.safeResolve(clean);
    const isDir = (await lstat(abs)).isDirectory();
    if (!isDir) return { abs, isDir };
    const check = (rel: string) => {
      if (paths.isHidden(rel)) throw new PathError('HIDDEN', 'Ziel enthält versteckte Pfade');
      if (paths.isExcluded(rel)) throw new PathError('EXCLUDED', 'Ordner enthält ausgeschlossene Pfade');
      if (paths.isReadonly(rel)) throw new PathError('READONLY', 'Ordner enthält schreibgeschützte Pfade');
    };
    const walk = async (dirAbs: string, rel: string): Promise<void> => {
      for (const d of await readdir(dirAbs, { withFileTypes: true })) {
        const name = nfc(d.name);
        if (name.startsWith('.')) continue;
        const child = `${rel}/${name}`;
        check(child);
        if (to !== null) check(to + child.slice(clean.length));
        if (d.isDirectory()) await walk(path.join(dirAbs, d.name), child);
      }
    };
    await walk(abs, clean);
    return { abs, isDir };
  }

  private async doRename(fromRel: string, toRel: string, updateLinks: boolean): Promise<RenameResult> {
    const { paths, files, index, bus, watcher } = this.deps;
    const from = this.writable(fromRel);
    const to = this.writable(toRel);
    if (to === from) throw new TargetExistsError();
    if (to.startsWith(from + '/')) throw new Error('Ein Ordner kann nicht in sich selbst verschoben werden');
    const src = await this.source(from, to);
    const toAbs = await paths.safeResolve(to);
    if (await existsAbs(toAbs)) throw new TargetExistsError();

    const moved = src.isDir
      ? this.indexedUnder(from).map((p) => ({ from: p, to: to + p.slice(from.length) }))
      : [{ from, to }];
    const renames = new Map(moved.map((m) => [m.from, m.to]));

    // Betroffene Notizen vor dem Verschieben lesen: Inhalt, Version, Links mit alten Zielen.
    const snapshots: Snapshot[] = [];
    /** Notizen, deren Links nicht angepasst werden können (kein gültiges UTF-8): als `failed` melden. */
    const notUtf8: string[] = [];
    const skippedReadonly: string[] = [];
    if (updateLinks) {
      const sources = new Set<string>();
      for (const m of moved) {
        if (isNote(m.from)) sources.add(m.from); // eigene relative Links
        for (const b of index.backlinks(m.from)) sources.add(b.source);
      }
      for (const s of [...sources].sort()) {
        if (paths.isReadonly(s)) {
          skippedReadonly.push(s);
          continue;
        }
        let r;
        try {
          r = await files.read(s);
        } catch (e) {
          if (isErrno(e, 'ENOENT', 'ENOTDIR') || e instanceof NotAFileError) continue; // inzwischen weg
          if (e instanceof NotUtf8Error) {
            notUtf8.push(s);
            continue;
          }
          throw e;
        }
        const { links } = parseNote(r.content);
        const lk = index.lookup();
        const resolved = links.map((l) => (l.target === '' ? s : resolveLink(l.target, s, lk)));
        snapshots.push({ path: s, content: r.content, version: r.version, links, resolved });
      }
    }

    if (dirname(to) !== '') await files.mkdir(dirname(to));
    watcher.markOwnMove(from, to);
    try {
      await moveNoReplace(src.abs, toAbs, src.isDir);
    } catch (e) {
      watcher.unmarkOwnMove(from, to);
      throw e;
    }

    // Index sofort nachziehen, damit Folgeaufrufe den neuen Stand sehen (der Watcher folgt still).
    for (const m of moved) index.remove(m.from);
    for (const m of moved) {
      if (!isNote(m.to)) index.addFile(m.to);
      else {
        try {
          index.upsert(m.to, (await files.read(m.to, { lossy: true })).content);
        } catch (e) {
          if (!(isErrno(e, 'ENOENT', 'ENOTDIR') || e instanceof NotAFileError)) throw e;
        }
      }
    }
    bus.publish({ type: 'renamed', from, to });

    const updated: string[] = [];
    const conflicts: string[] = [];
    const failed: string[] = notUtf8.map((s) => renames.get(s) ?? s);
    for (const s of snapshots) {
      const target = renames.get(s.path) ?? s.path;
      const next = rewriteLinks(s.content, s.links, s.resolved, renames, target, index.lookup());
      if (next === s.content) continue;
      let version: Version;
      try {
        version = await files.write(target, next, s.version);
      } catch (e) {
        // Nach dem Verschieben nicht mehr abbrechen: jede Notiz einzeln melden.
        (e instanceof ConflictError ? conflicts : failed).push(target);
        continue;
      }
      watcher.markOwnWrite(target, version);
      index.upsert(target, next);
      bus.publish({ type: 'changed', path: target, version });
      updated.push(target);
    }
    return { moved, updated: updated.sort(), skippedReadonly, conflicts: conflicts.sort(), failed: failed.sort() };
  }

  private async doTrash(rel: string): Promise<void> {
    const { paths, index, bus, watcher } = this.deps;
    const clean = this.writable(rel);
    const src = await this.source(clean, null);
    await mkdir(await paths.safeResolve(TRASH), { recursive: true, mode: 0o777 });

    const name = basename(clean);
    const ext = src.isDir ? '' : path.posix.extname(name);
    const stem = name.slice(0, name.length - ext.length);
    for (let i = 0; ; i++) {
      const target = `${TRASH}/${i === 0 ? name : `${stem} ${i}${ext}`}`;
      const targetAbs = await paths.safeResolve(target);
      if (await existsAbs(targetAbs)) continue;
      watcher.markOwnMove(clean, target);
      try {
        await moveNoReplace(src.abs, targetAbs, src.isDir);
      } catch (e) {
        watcher.unmarkOwnMove(clean, target);
        if (e instanceof TargetExistsError) continue; // gleichzeitig belegt: nächster Name
        throw e;
      }
      break;
    }

    for (const p of this.indexedUnder(clean)) index.remove(p);
    bus.publish({ type: 'deleted', path: clean });
  }
}

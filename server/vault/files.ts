import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, copyFile, link, lstat, mkdir, open, readdir, readFile, rename, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { nfc } from '@shared/normalize';
import { PathError, VaultPaths, normalizeRel } from './paths';

/** sha256-Hex der Datei-Bytes. */
export type Version = string;

export interface TreeEntry {
  path: string;
  name: string;
  kind: 'folder' | 'note' | 'file';
  mtime: number;
  size: number;
  readonly: boolean;
  children?: TreeEntry[];
}

/** Die Datei auf der Platte weicht von der erwarteten Version ab (oder existiert nicht / schon). */
export class ConflictError extends Error {
  constructor(
    public readonly diskContent: string | null,
    public readonly diskVersion: Version | null,
  ) {
    super('Konflikt: Datei wurde extern geändert');
    this.name = 'ConflictError';
  }
}

/**
 * Die Datei ist kein gültiges UTF-8 (z. B. Latin-1 von einem Skript). Sie darf nicht als Text
 * bearbeitet werden: Speichern würde ungültige Bytes dauerhaft durch U+FFFD ersetzen.
 */
export class NotUtf8Error extends Error {
  constructor() {
    super('Datei ist nicht UTF-8-kodiert');
    this.name = 'NotUtf8Error';
  }
}

/** read/readBytes auf etwas, das keine reguläre Datei ist (z. B. ein Ordner). */
export class NotAFileError extends Error {
  constructor(message = 'Pfad ist keine Datei') {
    super(message);
    this.name = 'NotAFileError';
  }
}

const MIME: Record<string, string> = {
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.flac': 'audio/flac',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.ogv': 'video/ogg',
  '.mov': 'video/quicktime',
  '.json': 'application/json',
};

const hash = (b: Buffer): Version => createHash('sha256').update(b).digest('hex');

/** Strikt: wirft bei ungültigem UTF-8. `ignoreBOM` behält ein U+FEFF im Text (wie `toString('utf8')`). */
const strictUtf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** Text der Bytes; ohne `lossy` NotUtf8Error bei ungültigem UTF-8. */
function decode(bytes: Buffer, lossy = false): string {
  if (lossy) return bytes.toString('utf8');
  try {
    return strictUtf8.decode(bytes);
  } catch {
    throw new NotUtf8Error();
  }
}

/** Endung der eigenen Temp-Dateien (`.<name>.<12 hex>.vwtmp`, versteckt im Zielordner). */
export const TEMP_SUFFIX = '.vwtmp';
const OWN_TEMP = /^\..*\.[0-9a-f]{12}\.vwtmp$/s;
/** Längster Namensteil der Zieldatei im Temp-Namen (NAME_MAX 255 Bytes; UTF-8 bis 4 Bytes je Zeichen). */
const TEMP_STEM_MAX = 50;

/** Name einer eigenen Temp-Datei (verwaiste werden beim Start entfernt). */
export function isOwnTempName(name: string): boolean {
  return OWN_TEMP.test(name);
}
const collator = new Intl.Collator('de', { numeric: true });

function isErrno(e: unknown, ...codes: string[]): boolean {
  return codes.includes((e as NodeJS.ErrnoException)?.code ?? '');
}

/** An upload streamed to a hidden temp file in the vault root; `createFromStaged` places it. */
export interface StagedFile {
  readonly size: number;
  readonly version: Version;
  /** Removes the temp file (always call when done). */
  discard(): Promise<void>;
}

const STAGED = Symbol('staged');
type StagedInternal = StagedFile & { [STAGED]: string };

export class VaultFiles {
  constructor(private readonly paths: VaultPaths) {}

  async tree(): Promise<TreeEntry> {
    const rootAbs = await this.paths.safeResolve('');
    const st = await stat(rootAbs);
    return {
      path: '',
      name: '',
      kind: 'folder',
      mtime: st.mtimeMs,
      size: 0,
      readonly: false,
      children: await this.walk(rootAbs, ''),
    };
  }

  private async walk(abs: string, rel: string): Promise<TreeEntry[]> {
    const out: TreeEntry[] = [];
    for (const d of await readdir(abs, { withFileTypes: true })) {
      const name = nfc(d.name);
      const childRel = rel ? `${rel}/${name}` : name;
      if (!this.paths.isVisible(childRel)) continue;
      const childAbs = path.join(abs, d.name); // echter Name auf der Platte (ggf. NFD)
      let st;
      if (d.isSymbolicLink()) {
        try {
          await this.paths.safeResolve(childRel); // Symlinks nur innerhalb des Vaults
          st = await stat(childAbs);
        } catch {
          continue;
        }
      } else {
        st = await lstat(childAbs).catch(() => undefined);
        if (!st) continue; // zwischenzeitlich gelöscht
      }
      const readonly = this.paths.isReadonly(childRel);
      if (st.isDirectory()) {
        let children: TreeEntry[];
        try {
          children = await this.walk(childAbs, childRel);
        } catch (e) {
          if (isErrno(e, 'ENOENT', 'ENOTDIR', 'EACCES')) continue;
          throw e;
        }
        out.push({ path: childRel, name, kind: 'folder', mtime: st.mtimeMs, size: 0, readonly, children });
      } else if (st.isFile()) {
        out.push({
          path: childRel,
          name,
          kind: name.toLowerCase().endsWith('.md') ? 'note' : 'file',
          mtime: st.mtimeMs,
          size: st.size,
          readonly,
        });
      }
    }
    out.sort((a, b) => (a.kind === 'folder' ? 0 : 1) - (b.kind === 'folder' ? 0 : 1) || collator.compare(a.name, b.name));
    return out;
  }

  /** Kanonischer Pfad + absoluter Pfad; verweigert versteckte/ausgeschlossene (und beim Schreiben readonly) Pfade. */
  private async guard(rel: string, write: boolean): Promise<{ clean: string; abs: string }> {
    const clean = normalizeRel(rel);
    if (this.paths.isHidden(clean)) throw new PathError('HIDDEN', 'Versteckter Pfad');
    if (this.paths.isExcluded(clean)) throw new PathError('EXCLUDED', 'Pfad ist ausgeschlossen');
    if (write && this.paths.isReadonly(clean)) throw new PathError('READONLY', 'Pfad ist schreibgeschützt');
    return { clean, abs: await this.paths.safeResolve(clean) };
  }

  /**
   * Text und Version einer Datei. Ungültiges UTF-8 → NotUtf8Error; nur mit `lossy` (Index/Suche,
   * die nie schreiben) werden ungültige Bytes durch U+FFFD ersetzt.
   */
  async read(rel: string, opts: { lossy?: boolean } = {}): Promise<{ content: string; version: Version }> {
    const { abs } = await this.guard(rel, false);
    if (!(await stat(abs)).isFile()) throw new NotAFileError();
    const bytes = await readFile(abs);
    // Kein BOM-Strippen: der String enthält ein evtl. vorhandenes U+FEFF.
    return { content: decode(bytes, opts.lossy), version: hash(bytes) };
  }

  async readBytes(rel: string): Promise<{ stream: Readable; size: number; mime: string }> {
    const { size, mime, stream } = await this.openBytes(rel);
    return { stream: stream(), size, mime };
  }

  /** Größe und Typ einer Datei; `stream` liest sie ganz oder einen Bereich (`end` inklusive). */
  async openBytes(
    rel: string,
  ): Promise<{ size: number; mime: string; stream: (range?: { start: number; end: number }) => Readable }> {
    const { abs } = await this.guard(rel, false);
    const st = await stat(abs);
    if (!st.isFile()) throw new NotAFileError();
    const mime = MIME[path.extname(abs).toLowerCase()] ?? 'application/octet-stream';
    return { size: st.size, mime, stream: (range) => createReadStream(abs, range) };
  }

  /** Überschreibt nur, wenn die Datei auf der Platte noch `baseVersion` hat. */
  async write(rel: string, content: string, baseVersion: Version): Promise<Version> {
    const { abs } = await this.guard(rel, true);
    const check = async (): Promise<number> => {
      let bytes: Buffer;
      try {
        bytes = await readFile(abs);
      } catch (e) {
        if (isErrno(e, 'ENOENT')) throw new ConflictError(null, null);
        throw e;
      }
      // Nie eine Nicht-UTF-8-Datei durch (umkodierten) Text ersetzen, auch nicht über den Konfliktdialog.
      const diskContent = decode(bytes);
      if (hash(bytes) !== baseVersion) throw new ConflictError(diskContent, hash(bytes));
      return (await stat(abs)).mode & 0o777;
    };
    const mode = await check();
    const data = Buffer.from(content, 'utf8');
    const tmp = await this.writeTemp(abs, data);
    try {
      await chmod(tmp, mode);
      await check(); // zweite Prüfung direkt vor dem Austausch verkleinert das Zeitfenster
      await rename(tmp, abs);
    } catch (e) {
      await unlink(tmp).catch(() => undefined);
      throw e;
    }
    return hash(data);
  }

  /** Legt eine neue Datei an; existiert sie schon, ConflictError (nichts wird überschrieben). */
  async create(rel: string, content: string): Promise<Version> {
    const data = Buffer.from(content, 'utf8');
    await this.createExclusive(rel, data);
    return hash(data);
  }

  /** Legt den Ordner (mit Eltern) an; true, wenn er neu ist. */
  async mkdir(rel: string): Promise<boolean> {
    const { abs } = await this.guard(rel, true);
    return (await mkdir(abs, { recursive: true, mode: 0o777 })) !== undefined; // Prozess-umask ergibt 0775
  }

  /** Schreibt neue Binärdatei (Anhang); überschreibt nie, bei Existenz ConflictError. */
  async writeBinary(rel: string, data: Buffer): Promise<void> {
    await this.createExclusive(rel, data);
  }

  /**
   * Entfernt verwaiste eigene Temp-Dateien (Absturz zwischen Schreiben und Umbenennen), die älter
   * als `maxAgeMs` sind. Nur das eigene Namensmuster, nur in sichtbaren Ordnern des Vaults, ohne
   * Symlinks zu folgen. Liefert die entfernten vault-relativen Pfade.
   */
  async removeOrphanTemps(maxAgeMs: number, now = Date.now()): Promise<string[]> {
    const removed: string[] = [];
    const visit = async (abs: string, rel: string): Promise<void> => {
      let entries;
      try {
        entries = await readdir(abs, { withFileTypes: true });
      } catch (e) {
        if (isErrno(e, 'ENOENT', 'ENOTDIR', 'EACCES')) return;
        throw e;
      }
      for (const d of entries) {
        const name = nfc(d.name);
        const childRel = rel ? `${rel}/${name}` : name;
        const childAbs = path.join(abs, d.name);
        if (d.isFile() && isOwnTempName(name)) {
          const st = await lstat(childAbs).catch(() => undefined);
          if (!st?.isFile() || now - st.mtimeMs < maxAgeMs) continue;
          await unlink(childAbs).then(
            () => removed.push(childRel),
            (e) => (isErrno(e, 'ENOENT') ? undefined : Promise.reject(e)),
          );
        } else if (d.isDirectory() && this.paths.isVisible(childRel)) {
          await visit(childAbs, childRel);
        }
      }
    };
    await visit(await this.paths.safeResolve(''), '');
    return removed;
  }

  /**
   * Schreibt einen Datenstrom (Upload) in eine versteckte Temp-Datei im Vault-Wurzelordner und
   * hasht dabei, ohne ihn im Speicher zu sammeln. Das Ziel steht evtl. erst danach fest.
   */
  async stageUpload(stream: Readable): Promise<StagedFile> {
    const root = await this.paths.safeResolve('');
    const tmp = path.join(root, `.upload.${randomBytes(6).toString('hex')}${TEMP_SUFFIX}`);
    const h = createHash('sha256');
    let size = 0;
    const fh = await open(tmp, 'wx', 0o666);
    try {
      for await (const chunk of stream) {
        const buf = chunk as Buffer;
        h.update(buf);
        size += buf.length;
        for (let off = 0; off < buf.length; ) off += (await fh.write(buf, off)).bytesWritten;
      }
      await fh.sync();
    } catch (e) {
      await fh.close().catch(() => undefined);
      await unlink(tmp).catch(() => undefined);
      throw e;
    }
    await fh.close();
    const staged: StagedInternal = {
      [STAGED]: tmp,
      size,
      version: h.digest('hex'),
      discard: () => unlink(tmp).catch(() => undefined),
    };
    return staged;
  }

  /** Legt `rel` mit dem Inhalt einer gestagten Datei an; überschreibt nie (sonst ConflictError). */
  async createFromStaged(rel: string, staged: StagedFile): Promise<void> {
    const src = (staged as StagedInternal)[STAGED];
    const { abs } = await this.guard(rel, true);
    await mkdir(path.dirname(abs), { recursive: true, mode: 0o777 });
    try {
      await link(src, abs);
      return;
    } catch (e) {
      if (isErrno(e, 'EEXIST')) throw new ConflictError(null, null);
      if (!isErrno(e, 'EXDEV')) throw e;
    }
    // Zielordner auf einem anderen Dateisystem: erst dort kopieren, dann exklusiv verlinken.
    const stem = [...path.basename(abs)].slice(0, TEMP_STEM_MAX).join('');
    const tmp = path.join(path.dirname(abs), `.${stem}.${randomBytes(6).toString('hex')}${TEMP_SUFFIX}`);
    try {
      await copyFile(src, tmp);
      await link(tmp, abs);
    } catch (e) {
      if (isErrno(e, 'EEXIST')) throw new ConflictError(null, null);
      throw e;
    } finally {
      await unlink(tmp).catch(() => undefined);
    }
  }

  /** Freier Pfad: `a/x.md` → `a/x 1.md` → `a/x 2.md` … */
  async uniquePath(rel: string): Promise<string> {
    const clean = normalizeRel(rel);
    const ext = path.posix.extname(clean);
    const stem = clean.slice(0, clean.length - ext.length);
    for (let i = 0; ; i++) {
      const candidate = i === 0 ? clean : `${stem} ${i}${ext}`;
      const { abs } = await this.guard(candidate, true);
      if (!(await lstat(abs).then(() => true, (e) => (isErrno(e, 'ENOENT', 'ENOTDIR') ? false : Promise.reject(e))))) {
        return candidate;
      }
    }
  }

  private async createExclusive(rel: string, data: Buffer): Promise<void> {
    const { abs } = await this.guard(rel, true);
    await mkdir(path.dirname(abs), { recursive: true, mode: 0o777 });
    const tmp = await this.writeTemp(abs, data);
    try {
      await link(tmp, abs); // atomar und schlägt bei Existenz fehl
    } catch (e) {
      if (isErrno(e, 'EEXIST')) {
        const bytes = await readFile(abs).catch(() => undefined);
        throw new ConflictError(bytes?.toString('utf8') ?? null, bytes ? hash(bytes) : null);
      }
      throw e;
    } finally {
      await unlink(tmp).catch(() => undefined);
    }
  }

  /**
   * Schreibt `.<ziel>.<zufall>.vwtmp` im selben Ordner (Modus 0666 & ~umask). Der Punkt am Anfang
   * versteckt sie vor Baum, Watcher und Obsidian; Syncthing braucht `.stignore` (siehe README).
   */
  private async writeTemp(abs: string, data: Buffer): Promise<string> {
    const stem = [...path.basename(abs)].slice(0, TEMP_STEM_MAX).join('');
    const tmp = path.join(path.dirname(abs), `.${stem}.${randomBytes(6).toString('hex')}${TEMP_SUFFIX}`);
    const fh = await open(tmp, 'wx', 0o666);
    try {
      await fh.writeFile(data);
      await fh.sync();
    } catch (e) {
      await fh.close();
      await unlink(tmp).catch(() => undefined);
      throw e;
    }
    await fh.close();
    return tmp;
  }
}

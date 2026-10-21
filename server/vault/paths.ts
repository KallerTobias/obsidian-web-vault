import { lstat, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import picomatch from 'picomatch';
import { nfc } from '@shared/normalize';

export type PathErrorCode = 'OUTSIDE' | 'HIDDEN' | 'EXCLUDED' | 'READONLY';

export class PathError extends Error {
  constructor(
    public readonly code: PathErrorCode,
    message?: string,
  ) {
    super(message ?? code);
    this.name = 'PathError';
  }
}

/**
 * Kanonische vault-relative Form: NFC, posix-normalisiert, ohne führendes "./" und
 * abschließendes "/". Wirft OUTSIDE bei führendem "/", NUL oder Ausbruch per "..".
 */
export function normalizeRel(rel: string): string {
  const n = nfc(rel);
  if (n.includes('\0') || n.startsWith('/')) throw new PathError('OUTSIDE', 'Pfad außerhalb des Vaults');
  let out = path.posix.normalize(n);
  if (out === '.' || out === './') return '';
  out = out.replace(/^(\.\/)+/, '').replace(/\/+$/, '');
  if (out.split('/').includes('..')) throw new PathError('OUTSIDE', 'Pfad außerhalb des Vaults');
  return out;
}

/** Temporäre Dateien anderer Programme: ein Segment endet auf `.tmp`. */
function isTempLike(rel: string): boolean {
  return normalizeRel(rel)
    .split('/')
    .some((s) => s.toLowerCase().endsWith('.tmp'));
}

function isInside(root: string, p: string): boolean {
  return p === root || p.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
}

/**
 * Sicherheitsgrenze: bildet vault-relative Pfade auf absolute Dateisystempfade ab
 * und klassifiziert sie. `safeResolve` prüft nur die Eingrenzung (OUTSIDE);
 * HIDDEN/EXCLUDED/READONLY werden von den Aufrufern anhand der is*-Methoden durchgesetzt.
 */
export class VaultPaths {
  private readonly root: string;
  private realRoot: Promise<string> | undefined;
  private readonly excludeMatch: (p: string) => boolean;
  private readonly readonlyMatch: (p: string) => boolean;

  constructor(root: string, exclude: string[], readonly: string[]) {
    this.root = path.resolve(root);
    this.excludeMatch = exclude.length ? picomatch(exclude.map(nfc), { dot: false }) : () => false;
    this.readonlyMatch = readonly.length ? picomatch(readonly.map(nfc), { dot: false }) : () => false;
  }

  normalizeRel(rel: string): string {
    return normalizeRel(rel);
  }

  async safeResolve(rel: string): Promise<string> {
    const clean = normalizeRel(rel);
    const abs = await this.resolveOnDisk(clean);
    if (!isInside(this.root, abs)) throw new PathError('OUTSIDE', 'Pfad außerhalb des Vaults');

    const realRoot = await (this.realRoot ??= realpath(this.root));
    // Nächsten existierenden Vorfahren auflösen; Symlinks dürfen nicht aus dem Vault führen
    // und nicht in versteckte/ausgeschlossene Bereiche umleiten.
    let probe = abs;
    for (;;) {
      try {
        const real = await realpath(probe);
        if (!isInside(realRoot, real)) throw new PathError('OUTSIDE', 'Symlink führt aus dem Vault');
        const tail = path.relative(probe, abs);
        const realRel = nfc(path.relative(realRoot, path.join(real, tail)).split(path.sep).join('/'));
        this.checkRedirect(clean, realRel);
        break;
      } catch (e) {
        if (e instanceof PathError) throw e;
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT' && (e as NodeJS.ErrnoException).code !== 'ENOTDIR') throw e;
      }
      // realpath scheitert auch bei hängenden Symlinks: die dürfen nicht übersprungen werden.
      const st = await lstat(probe).catch(() => undefined);
      if (st?.isSymbolicLink()) throw new PathError('OUTSIDE', 'Hängender Symlink');
      const parent = path.dirname(probe);
      if (parent === probe) throw new PathError('OUTSIDE', 'Pfad außerhalb des Vaults');
      probe = parent;
    }
    return abs;
  }

  /**
   * Bildet den NFC-Pfad auf die echten Namen auf der Platte ab (macOS/Syncthing legt NFD an):
   * je Segment der exakte Name, sonst der Eintrag mit gleicher NFC-Form, sonst der NFC-Name (neu).
   */
  private async resolveOnDisk(clean: string): Promise<string> {
    let cur = this.root;
    const segs = clean === '' ? [] : clean.split('/');
    for (let i = 0; i < segs.length; i++) {
      const seg = segs[i]!;
      const exact = path.join(cur, seg);
      if (await lstat(exact).then(() => true, () => false)) {
        cur = exact;
        continue;
      }
      const entries = await readdir(cur).catch(() => [] as string[]);
      const match = entries.find((e) => nfc(e) === seg);
      if (match === undefined) return path.join(cur, ...segs.slice(i)); // neu: Rest unverändert
      cur = path.join(cur, match);
    }
    return cur;
  }

  /** Verhindert, dass ein Symlink einen sichtbaren Pfad in einen versteckten/ausgeschlossenen Bereich umleitet. */
  private checkRedirect(lexical: string, real: string): void {
    if (lexical === '.trash' || lexical.startsWith('.trash/')) {
      if (real !== '.trash' && !real.startsWith('.trash/')) throw new PathError('HIDDEN', 'Papierkorb führt woandershin');
      return;
    }
    if (!this.isHidden(lexical) && this.isHidden(real)) throw new PathError('HIDDEN', 'Symlink führt in versteckten Bereich');
    if (!this.isExcluded(lexical) && this.isExcluded(real)) throw new PathError('EXCLUDED', 'Symlink führt in ausgeschlossenen Bereich');
  }

  isHidden(rel: string): boolean {
    return normalizeRel(rel)
      .split('/')
      .some((s) => s.startsWith('.'));
  }

  isExcluded(rel: string): boolean {
    return this.excludeMatch(normalizeRel(rel));
  }

  isReadonly(rel: string): boolean {
    return this.readonlyMatch(normalizeRel(rel));
  }

  /**
   * Sichtbar in Baum, Index und Watcher (eine gemeinsame Regel): nicht versteckt, nicht
   * ausgeschlossen und kein `*.tmp` (Syncthing schreibt `~syncthing~name.tmp`).
   */
  isVisible(rel: string): boolean {
    return !this.isHidden(rel) && !this.isExcluded(rel) && !isTempLike(rel);
  }
}

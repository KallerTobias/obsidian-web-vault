import { basename, dirname, nfc, stripMd } from './normalize';

/** Lookup tables for link resolution. Keys are NFC + lowercase; values are the real paths. */
export interface FileLookup {
  /** lowercase NFC path -> real path */
  byPath: Map<string, string>;
  /** lowercase NFC file name (with extension, e.g. "bild.jpg", "notiz.md") -> real paths */
  byBasename: Map<string, string[]>;
}

export function lookupKey(s: string): string {
  return nfc(s).toLowerCase();
}

/** Key grouping links by the file they could point to: lowercase file name without ".md". */
export function linkKey(target: string): string {
  return stripMd(lookupKey(basename(target)));
}

/** Joins a folder and a relative target, resolving "." and ".."; null if it escapes the vault. */
function joinRelative(dir: string, target: string): string | null {
  const out = dir === '' ? [] : dir.split('/');
  for (const seg of target.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (out.length === 0) return null;
      out.pop();
    } else out.push(seg);
  }
  return out.join('/');
}

function better(a: string, b: string): boolean {
  const da = a.split('/').length;
  const db = b.split('/').length;
  if (da !== db) return da < db;
  if (a.length !== b.length) return a.length < b.length;
  return a < b;
}

/**
 * Resolves a link target to a real vault path, or null. Order:
 * 1. path relative to the source's folder, then from the vault root (each with and without ".md");
 * 2. file name anywhere in the vault: same folder as the source, else shortest path, else alphabetical.
 */
export function resolveLink(target: string, sourcePath: string, files: FileLookup): string | null {
  let tl = lookupKey(target).trim();
  if (tl.charCodeAt(0) === 47) tl = tl.replace(/^\/+/, '');
  if (tl === '') return null;
  const srcDir = lookupKey(dirname(sourcePath));

  // No "." / ".." segments: plain concatenation is enough.
  const plain = tl.charCodeAt(0) !== 46 && !tl.includes('/.') && !tl.includes('//');
  for (const base of srcDir === '' ? [''] : [srcDir, '']) {
    const joined = plain ? (base === '' ? tl : base + '/' + tl) : joinRelative(base, tl);
    if (joined === null || joined === '') continue;
    const hit = files.byPath.get(joined) ?? files.byPath.get(joined + '.md');
    if (hit !== undefined) return hit;
  }

  const hasSlash = tl.includes('/');
  const found: string[] = [];
  for (const vl of [tl, tl + '.md']) {
    const list = files.byBasename.get(hasSlash ? basename(vl) : vl);
    if (!list) continue;
    for (const p of list) {
      if (hasSlash) {
        const pl = lookupKey(p);
        if (pl !== vl && !pl.endsWith('/' + vl)) continue;
      }
      found.push(p);
    }
  }
  if (found.length <= 1) return found[0] ?? null;
  let best = found[0]!;
  let bestSame = lookupKey(dirname(best)) === srcDir;
  for (let i = 1; i < found.length; i++) {
    const p = found[i]!;
    const same = lookupKey(dirname(p)) === srcDir;
    if ((same && !bestSame) || (same === bestSame && better(p, best))) {
      best = p;
      bestSame = same;
    }
  }
  return best;
}

/** Text to put inside `[[...]]` / `[](...)` for linking `targetPath` from `sourcePath`. */
export function linkTextFor(
  targetPath: string,
  sourcePath: string,
  files: FileLookup,
  format: 'shortest' | 'absolute' | 'relative',
): string {
  const noExt = stripMd(targetPath);
  if (format === 'absolute') return noExt;
  if (format === 'relative') {
    const from = dirname(sourcePath) === '' ? [] : dirname(sourcePath).split('/');
    const to = noExt.split('/');
    let i = 0;
    while (i < from.length && i < to.length - 1 && lookupKey(from[i]!) === lookupKey(to[i]!)) i++;
    return [...from.slice(i).map(() => '..'), ...to.slice(i)].join('/');
  }
  const list = files.byBasename.get(lookupKey(basename(targetPath)));
  return list !== undefined && list.length === 1 ? stripMd(basename(targetPath)) : noExt;
}

/** Builds lookup tables from a list of vault paths (the same keys the server index uses). */
export function createFileLookup(paths: Iterable<string>): FileLookup {
  const lk: FileLookup = { byPath: new Map(), byBasename: new Map() };
  for (const path of paths) {
    lk.byPath.set(lookupKey(path), path);
    const bk = lookupKey(basename(path));
    const list = lk.byBasename.get(bk);
    if (list) list.push(path);
    else lk.byBasename.set(bk, [path]);
  }
  return lk;
}

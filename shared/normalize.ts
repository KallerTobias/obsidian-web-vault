/** Path helpers shared by server and web. All paths are vault-relative, "/"-separated, NFC. */

export function nfc(s: string): string {
  return s.normalize('NFC');
}

/** Joins segments with single "/" separators, dropping empty segments and surrounding slashes. */
export function joinPath(...parts: string[]): string {
  return nfc(parts.flatMap((p) => p.split('/')).filter((s) => s !== '').join('/'));
}

export function dirname(p: string): string {
  const i = p.lastIndexOf('/');
  return i < 0 ? '' : p.slice(0, i);
}

export function basename(p: string): string {
  return p.slice(p.lastIndexOf('/') + 1);
}

/** `target` joined to `dir` (`.`/`..` resolved, never above the vault root; a leading `/` is the root). */
export function relativeTo(dir: string, target: string): string {
  const out = target.startsWith('/') || dir === '' ? [] : dir.split('/');
  for (const seg of target.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') out.pop();
    else out.push(seg);
  }
  return out.join('/');
}

/** Removes a trailing ".md" extension (case-sensitive). */
export function stripMd(p: string): string {
  return p.endsWith('.md') ? p.slice(0, -3) : p;
}

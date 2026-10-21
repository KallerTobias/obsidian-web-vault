/** Search query syntax shared by server (full-text search) and web (graph filters/groups). */
import { nfc } from './normalize';

export interface QueryTerm {
  kind: 'text' | 'path' | 'tag' | 'file';
  /**
   * Value as typed, NFC, quotes removed. For `tag` WITHOUT the leading `#`
   * (same form as `TagRef.tag` / `SearchIndex.upsert` tags).
   */
  value: string;
  /** True when the value was quoted (text: exact phrase). */
  phrase: boolean;
  negate: boolean;
}

/** Lowercase + NFD with combining marks removed ("Käse" -> "kase"). Comparison form only. */
export function fold(s: string): string {
  return s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

const OPERATORS = new Set(['path', 'tag', 'file']);

/**
 * Syntax: `word`, `"exact phrase"`, `-word` (exclude), `path:Ordner/Sub` (path prefix),
 * `tag:name` / `tag:#name` (incl. subtags), `file:Name` (file name); operator values may be quoted.
 */
export function parseQuery(q: string): QueryTerm[] {
  const terms: QueryTerm[] = [];
  const n = q.length;
  let i = 0;
  while (i < n) {
    if (/\s/.test(q[i]!)) { i++; continue; }
    let negate = false;
    if (q[i] === '-') { negate = true; i++; }
    let kind: QueryTerm['kind'] = 'text';
    const m = /^([a-z]+):/i.exec(q.slice(i));
    if (m && OPERATORS.has(m[1]!.toLowerCase())) {
      kind = m[1]!.toLowerCase() as QueryTerm['kind'];
      i += m[0].length;
    }
    let value: string;
    let phrase = false;
    if (q[i] === '"') {
      phrase = true;
      const end = q.indexOf('"', i + 1);
      value = q.slice(i + 1, end < 0 ? n : end);
      i = end < 0 ? n : end + 1;
    } else {
      let j = i;
      while (j < n && !/\s/.test(q[j]!)) j++;
      value = q.slice(i, j);
      i = j;
    }
    value = nfc(value.trim());
    if (kind === 'tag') value = value.replace(/^#+/, '');
    if (value === '') continue;
    terms.push({ kind, value, phrase, negate });
  }
  return terms;
}

/** Pre-folded note metadata (see `fold`), so repeated matching avoids re-normalizing. */
export interface FoldedMeta { path: string; name: string; tags: string[] }

export function foldMeta(meta: { path: string; name: string; tags: string[] }): FoldedMeta {
  return { path: fold(meta.path), name: fold(meta.name), tags: meta.tags.map(fold) };
}

/** Operator term (path/tag/file) against folded metadata; `foldedValue` = fold(term.value). Not for text terms. */
export function matchesFolded(term: QueryTerm, foldedValue: string, meta: FoldedMeta): boolean {
  let hit: boolean;
  if (term.kind === 'path') hit = meta.path.startsWith(foldedValue);
  else if (term.kind === 'tag') hit = meta.tags.some((t) => t === foldedValue || t.startsWith(foldedValue + '/'));
  else hit = meta.name.includes(foldedValue); // 'file' and 'text' (name only)
  return hit !== term.negate;
}

/** All terms must hold. Text terms only check the note name (used for graph filters/groups). */
export function matchesMeta(terms: QueryTerm[], meta: { path: string; name: string; tags: string[] }): boolean {
  const folded = foldMeta(meta);
  return terms.every((t) => matchesFolded(t, fold(t.value), folded));
}

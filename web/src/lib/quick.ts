import { dirname } from '@shared/normalize';
import type { LookupEntry } from './api';
import { fuzzyScore } from './fuzzy';
import { lang } from './i18n';
import { isNotePath } from './tree';

export interface QuickMatch {
  path: string;
  /** Note name (without `.md`). */
  name: string;
  /** Set when the note was found by this alias. */
  alias?: string;
  folder: string;
}

/** A hit in the folder path counts less than one in the name. */
const PATH_PENALTY = 300;

/**
 * Notes for the quick switcher. With a query: name, aliases (a matching alias is listed as its own entry) and
 * folder, best first. Without: recently opened notes in their order, then all others by name.
 */
export function quickMatches(entries: readonly LookupEntry[], query: string, recent: readonly string[], limit = 50): QuickMatch[] {
  const notes = entries.filter((e) => isNotePath(e.path));
  const plain = (e: LookupEntry): QuickMatch => ({ path: e.path, name: e.name, folder: dirname(e.path) });
  const q = query.trim();

  if (q === '') {
    const byPath = new Map(notes.map((e) => [e.path, e]));
    const first = recent.flatMap((p) => byPath.get(p) ?? []);
    const seen = new Set(first.map((e) => e.path));
    const rest = notes.filter((e) => !seen.has(e.path)).sort((a, b) => a.name.localeCompare(b.name, lang, { sensitivity: 'base' }));
    return [...first, ...rest].slice(0, limit).map(plain);
  }

  const scored: { match: QuickMatch; score: number }[] = [];
  for (const e of notes) {
    const byName = fuzzyScore(q, e.name);
    const byPath = fuzzyScore(q, e.path);
    const score = Math.max(byName ?? -Infinity, byPath === null ? -Infinity : byPath - PATH_PENALTY);
    if (score > -Infinity) scored.push({ match: plain(e), score });
    for (const alias of e.aliases) {
      const s = fuzzyScore(q, alias);
      if (s !== null) scored.push({ match: { ...plain(e), alias }, score: s });
    }
  }
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => s.match);
}

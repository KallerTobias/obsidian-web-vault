import { fold } from '@shared/query';

/** A word starts at the beginning or after anything that is not a letter or digit. */
const isWordStart = (s: string, i: number) => i === 0 || !/[\p{L}\p{N}]/u.test(s[i - 1]!);

/**
 * How well `query` matches `text` (both already folded): 0 = not at all. Prefix > word start > substring >
 * scattered letters (each at a word start earns a bonus); shorter texts rank higher.
 */
export function scoreFolded(query: string, text: string): number {
  if (query === '') return 1;
  let best = 0;
  for (let i = text.indexOf(query); i >= 0; i = text.indexOf(query, i + 1)) {
    best = Math.max(best, i === 0 ? 1000 : isWordStart(text, i) ? 800 : 500);
  }
  if (best > 0) return best - Math.min(text.length, 99) + (text === query ? 200 : 0);
  let score = 100;
  let from = 0;
  for (const ch of query) {
    const i = text.indexOf(ch, from);
    if (i < 0) return 0;
    if (isWordStart(text, i)) score += 20;
    if (i === from) score += 5; // consecutive
    from = i + 1;
  }
  return score - Math.min(text.length, 99);
}

/** Fuzzy match independent of case and diacritics (`übs` finds `Übersicht`); null = no match, higher = better. */
export function fuzzyScore(query: string, candidate: string): number | null {
  const s = scoreFolded(fold(query), fold(candidate));
  return s > 0 ? s : null;
}

import MiniSearch from 'minisearch';
import { basename, nfc, stripMd } from '@shared/normalize';
import { fold, foldMeta, matchesFolded, type FoldedMeta, parseQuery, type QueryTerm } from '@shared/query';

export interface SearchHit {
  path: string;
  score: number;
  /** `line` is 0-based; `ranges` are [start, end) character offsets within `text` (the original line). */
  matches: { line: number; text: string; ranges: [number, number][] }[];
}

interface Doc {
  path: string;
  name: string;
  text: string;
  /** fold(name + '\n' + text), for phrase/exclusion checks. */
  folded: string;
  meta: FoldedMeta;
}

const WORD_CHAR = /[\p{L}\p{N}]/u;

/** Index of the first occurrence of `needle` in `hay` at/after `from` that starts a word (prefix match at the end is fine). */
function indexOfWordStart(hay: string, needle: string, from = 0): number {
  for (let at = hay.indexOf(needle, from); at >= 0; at = hay.indexOf(needle, at + 1)) {
    if (at === 0 || !WORD_CHAR.test(hay[at - 1]!)) return at;
  }
  return -1;
}

const MAX_MATCH_LINES = 10;

/** Folded string plus, per folded char, the [start, end) span it came from in the original. */
function foldWithMap(s: string): { folded: string; starts: number[]; ends: number[] } {
  let folded = '';
  const starts: number[] = [];
  const ends: number[] = [];
  let i = 0;
  for (const ch of s) {
    const j = i + ch.length;
    const f = fold(ch);
    if (f === '') {
      if (ends.length > 0) ends[ends.length - 1] = j; // absorb combining mark into previous char
    } else {
      for (let k = 0; k < f.length; k++) { starts.push(i); ends.push(j); }
      folded += f;
    }
    i = j;
  }
  return { folded, starts, ends };
}

const termCache = new Map<string, string>();
/** Memoized `fold` for index terms (vocabulary is small compared to token count). */
function foldTerm(t: string): string {
  let f = termCache.get(t);
  if (f === undefined) {
    f = fold(t);
    if (termCache.size > 200_000) termCache.clear();
    termCache.set(t, f);
  }
  return f;
}

export class SearchIndex {
  private docs = new Map<string, Doc>();
  private mini = new MiniSearch<{ id: string; name: string; text: string }>({
    fields: ['name', 'text'],
    processTerm: foldTerm,
    searchOptions: { prefix: true, processTerm: foldTerm, boost: { name: 2 } },
  });

  /** `tags` without leading `#`. */
  upsert(path: string, text: string, tags: string[]): void {
    const p = nfc(path);
    this.remove(p);
    const name = basename(stripMd(p));
    const doc: Doc = { path: p, name, text, folded: fold(name + '\n' + text), meta: foldMeta({ path: p, name, tags }) };
    this.docs.set(p, doc);
    this.mini.add({ id: p, name, text });
  }

  remove(path: string): void {
    const p = nfc(path);
    if (!this.docs.delete(p)) return;
    this.mini.discard(p);
  }

  search(q: string, limit = 50): SearchHit[] {
    const terms = parseQuery(q);
    if (terms.length === 0) return [];
    const ops = terms.filter((t) => t.kind !== 'text');
    const positive = terms.filter((t) => t.kind === 'text' && !t.negate);
    const negative = terms.filter((t) => t.kind === 'text' && t.negate);
    const needles = positive.map((t) => fold(t.value));
    const opValues = ops.map((t) => fold(t.value));
    const negNeedles = negative.map((t) => fold(t.value));

    const passes = (d: Doc): boolean => {
      if (!ops.every((t, i) => matchesFolded(t, opValues[i]!, d.meta))) return false;
      if (negNeedles.some((n) => indexOfWordStart(d.folded, n) >= 0)) return false;
      return positive.every((t, i) => !t.phrase || indexOfWordStart(d.folded, needles[i]!) >= 0);
    };

    if (positive.length === 0) {
      return [...this.docs.values()]
        .filter(passes)
        .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
        .slice(0, limit)
        .map((d) => ({ path: d.path, score: 0, matches: [] }));
    }

    const queries = positive.map((t) => this.toMiniQuery(t));
    // Fuzzy matching (0.1) is costly on a large index, so it only kicks in when the exact/prefix pass finds nothing.
    for (const fuzzy of [false, 0.1] as const) {
      const hits: SearchHit[] = [];
      for (const r of this.mini.search({ queries, combineWith: 'AND', fuzzy })) {
        const d = this.docs.get(r.id as string);
        if (!d || !passes(d)) continue;
        hits.push({ path: d.path, score: r.score, matches: this.contextLines(d, needles) });
        if (hits.length >= limit) break;
      }
      if (hits.length > 0) return hits;
    }
    return [];
  }

  private toMiniQuery(t: QueryTerm) {
    if (!t.phrase) return t.value;
    // Candidates: all words of the phrase (exact); exact sequence is verified afterwards.
    return { queries: [t.value], combineWith: 'AND' as const, prefix: false, fuzzy: false as const };
  }

  private contextLines(d: Doc, needles: string[]): SearchHit['matches'] {
    const out: SearchHit['matches'] = [];
    const lines = d.text.split('\n');
    for (let ln = 0; ln < lines.length && out.length < MAX_MATCH_LINES; ln++) {
      const raw = lines[ln]!;
      const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
      if (line === '') continue;
      const quick = fold(line);
      if (!needles.some((n) => n !== '' && indexOfWordStart(quick, n) >= 0)) continue;
      const { folded, starts, ends } = foldWithMap(line);
      const ranges: [number, number][] = [];
      for (const needle of needles) {
        if (needle === '') continue;
        for (let at = indexOfWordStart(folded, needle); at >= 0; at = indexOfWordStart(folded, needle, at + needle.length)) {
          ranges.push([starts[at]!, ends[at + needle.length - 1]!]);
        }
      }
      if (ranges.length === 0) continue;
      ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
      const merged: [number, number][] = [];
      for (const r of ranges) {
        const last = merged[merged.length - 1];
        if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
        else merged.push([r[0], r[1]]);
      }
      out.push({ line: ln, text: line, ranges: merged });
    }
    return out;
  }
}

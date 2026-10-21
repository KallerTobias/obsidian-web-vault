import type { Completion, CompletionContext, CompletionResult } from '@codemirror/autocomplete';
import { fold } from '@shared/query';
import { linkTextFor, resolveLink, type FileLookup } from '@shared/resolve';
import { stripMd } from '@shared/normalize';
import type { LookupEntry } from '../api';
import { scoreFolded as fuzzyScore } from '../fuzzy';

/** What `[[` completion needs from the app. */
export interface WikilinkSource {
  entries: readonly LookupEntry[];
  files: FileLookup;
  /** The note being edited (links are written relative to it). */
  sourcePath: string;
  format: 'shortest' | 'absolute' | 'relative';
}

const LIMIT = 50;

/** Heading text as written inside `[[Note#…]]` (Obsidian replaces characters that would break the link). */
function headingLinkText(text: string): string {
  return text.replace(/[#|^:[\]]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Replaces the typed query by `text` and makes sure `]]` follows (without doubling an existing one). */
function insert(text: string, closeWith: string): NonNullable<Completion['apply']> {
  return (view, _completion, from, to) => {
    const hasClose = view.state.sliceDoc(to, to + 2) === ']]';
    const end = to + (hasClose ? 2 : 0);
    const insertText = text + closeWith;
    view.dispatch({
      changes: { from, to: end, insert: insertText },
      selection: { anchor: from + insertText.length },
      userEvent: 'input.complete',
    });
  };
}

function headingOptions(entry: LookupEntry | undefined, query: string): Completion[] {
  const scored: { c: Completion; score: number }[] = [];
  const q = fold(query);
  for (const h of entry?.headings ?? []) {
    const text = headingLinkText(h.text);
    if (text === '') continue;
    const score = fuzzyScore(q, fold(h.text));
    if (score > 0) scored.push({ c: { label: h.text, detail: `H${h.level}`, apply: insert(text, ']]') }, score });
  }
  // Document order when nothing was typed, else by match quality.
  if (q !== '') scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, LIMIT).map((s) => s.c);
}

/**
 * `[[` → notes (name, aliases, path; fuzzy), `[[Name#` → headings of that note (`[[#` = this note),
 * after `|` nothing. Inserts according to `newLinkFormat` and closes the brackets.
 */
export function wikilinkCompletions(ctx: CompletionContext, src: WikilinkSource): CompletionResult | null {
  const m = ctx.matchBefore(/\[\[[^[\]|\n]*/);
  if (!m) return null;
  const typed = m.text.slice(2);
  const hash = typed.indexOf('#');

  if (hash >= 0) {
    const name = typed.slice(0, hash);
    const target = name.trim() === '' ? src.sourcePath : resolveLink(name, src.sourcePath, src.files);
    if (target === null) return null;
    const options = headingOptions(
      src.entries.find((e) => e.path === target),
      typed.slice(hash + 1),
    );
    return { from: m.from + 2 + hash + 1, options, filter: false };
  }

  const q = fold(typed.trim());
  // Notes sharing a name are told apart by their path.
  const nameCount = new Map<string, number>();
  for (const e of src.entries) nameCount.set(e.name, (nameCount.get(e.name) ?? 0) + 1);

  const scored: { c: Completion; score: number }[] = [];
  const push = (c: Completion, score: number) => {
    if (score > 0) scored.push({ c, score });
  };
  for (const e of src.entries) {
    const linkText = linkTextFor(e.path, src.sourcePath, src.files, src.format);
    const isNote = e.path.endsWith('.md');
    const folded = fold(e.name);
    // The path only matters as a weaker second chance (typing a folder name finds its notes).
    const byName = fuzzyScore(q, folded);
    const score = byName > 0 ? byName + 50 : Math.floor(fuzzyScore(q, fold(stripMd(e.path))) / 4);
    push(
      {
        label: e.name,
        detail: (nameCount.get(e.name) ?? 0) > 1 ? stripMd(e.path) : undefined,
        type: isNote ? 'text' : 'file',
        apply: insert(linkText, ']]'),
      },
      score,
    );
    for (const alias of e.aliases) {
      push(
        { label: alias, detail: `→ ${e.name}`, type: 'text', apply: insert(`${linkText}|${alias}`, ']]') },
        fuzzyScore(q, fold(alias)) + 40,
      );
    }
  }
  scored.sort((a, b) => b.score - a.score || a.c.label.localeCompare(b.c.label));
  return { from: m.from + 2, options: scored.slice(0, LIMIT).map((s) => s.c), filter: false };
}

/** `#tag` at a word start (not `#` alone, not a heading): tags of the vault, prefix matches first. `tags` come without `#`. */
export function tagCompletions(ctx: CompletionContext, tags: readonly string[]): CompletionResult | null {
  const m = ctx.matchBefore(/(?<![\p{L}\p{N}_/#&-])#[\p{L}\p{N}_/-]+/u);
  if (!m) return null;
  const q = fold(m.text.slice(1));
  const scored: { tag: string; score: number }[] = [];
  for (const tag of tags) {
    const f = fold(tag);
    if (f === q) continue; // already typed in full
    const score = f.startsWith(q) ? 2 : f.includes('/' + q) ? 1 : 0;
    if (score > 0) scored.push({ tag, score });
  }
  scored.sort((a, b) => b.score - a.score); // stable: the caller's order (most used first) decides within a group
  return {
    from: m.from,
    options: scored.slice(0, LIMIT).map((s) => ({ label: `#${s.tag}`, type: 'keyword' })),
    filter: false,
  };
}

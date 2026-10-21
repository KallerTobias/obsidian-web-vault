import { parseNote } from '@shared/parse';
import { lookupKey } from '@shared/resolve';
import { basename, nfc, stripMd } from '@shared/normalize';

/** A piece of a context line; `hit` pieces are highlighted. */
export interface Segment {
  text: string;
  hit: boolean;
}

/** Whole-word, case-insensitive mentions of any of `names` (as the server finds unlinked mentions). */
export function mentionPattern(names: string[]): RegExp | null {
  const clean = names.map((n) => nfc(n).trim()).filter((n) => n !== '');
  if (clean.length === 0) return null;
  // Longest first: "Projekt Alpha" wins over "Projekt".
  const esc = [...new Set(clean)].sort((a, b) => b.length - a.length).map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(`(?<![\\p{L}\\p{N}_])(?:${esc.join('|')})(?![\\p{L}\\p{N}_])`, 'giu');
}

function split(text: string, ranges: { from: number; to: number }[]): Segment[] {
  const out: Segment[] = [];
  let pos = 0;
  for (const r of ranges) {
    if (r.from > pos) out.push({ text: text.slice(pos, r.from), hit: false });
    out.push({ text: text.slice(r.from, r.to), hit: true });
    pos = r.to;
  }
  if (pos < text.length || out.length === 0) out.push({ text: text.slice(pos), hit: false });
  return out;
}

/** `text` split into plain and mention pieces. */
export function mentionSegments(text: string, re: RegExp): Segment[] {
  return split(text, unlinkedMentions(text, re));
}

/** Mentions in `line` that are not inside a link (exactly those „Verlinken“ may replace). */
function unlinkedMentions(line: string, re: RegExp): { from: number; to: number }[] {
  const links = parseNote(line).links;
  const out: { from: number; to: number }[] = [];
  for (const m of line.matchAll(new RegExp(re.source, re.flags))) {
    const from = m.index;
    const to = from + m[0].length;
    if (!links.some((l) => from < l.to && to > l.from)) out.push({ from, to });
  }
  return out;
}

/** Whether a link target as written (`Ordner/Ziel`, `Ziel.md`, `../Ziel`) can mean `path`. */
function pointsTo(target: string, path: string): boolean {
  const t = lookupKey(stripMd(target.replace(/^(\.\.?\/)+/, '')));
  if (t === '') return false;
  const p = lookupKey(stripMd(path));
  return p === t || p.endsWith('/' + t) || lookupKey(stripMd(basename(path))) === t;
}

/** `text` (a context line) split into plain pieces and the links in it that point to `path`. */
export function linkedSegments(text: string, path: string): Segment[] {
  const links = parseNote(text).links.filter((l) => pointsTo(l.target, path));
  return split(text, links.map((l) => ({ from: l.from, to: l.to })));
}

/**
 * Turns the first unlinked mention of `names` on 0-based `line` of `content` into `[[linkText]]`
 * (`[[linkText|mention]]` when the mention is written differently and can be an alias). Null when the line
 * has no such mention, or — with `context` — when the line (trimmed) is no longer the context that was shown.
 */
export function linkMention(content: string, line: number, names: string[], linkText: string, context?: string): string | null {
  const re = mentionPattern(names);
  if (!re || line < 0) return null;
  let start = 0;
  for (let i = 0; i < line; i++) {
    const nl = content.indexOf('\n', start);
    if (nl < 0) return null;
    start = nl + 1;
  }
  let end = content.indexOf('\n', start);
  if (end < 0) end = content.length;
  if (content[end - 1] === '\r') end--;
  const text = content.slice(start, end);
  if (context !== undefined && text.trim() !== context) return null;
  const hit = unlinkedMentions(text, re)[0];
  if (!hit) return null;
  const mention = text.slice(hit.from, hit.to);
  const aliasOk = mention !== linkText && !/\||\]\]/.test(mention);
  const link = aliasOk ? `[[${linkText}|${mention}]]` : `[[${linkText}]]`;
  return content.slice(0, start + hit.from) + link + content.slice(start + hit.to);
}

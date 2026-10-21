import { parse as parseYaml } from 'yaml';
import { nfc as nfcFull } from './normalize';
import type { Heading, LinkRef, ParsedNote, TagRef } from './types';

/*
 * Line-based Obsidian note scanner (not a full Markdown parser, so it stays fast for thousands of notes).
 * Skips code fences, inline code, %%comments%% and math. Offsets are UTF-16 indices into the original text;
 * line numbers are 0-based (see types.ts).
 */

const WIKI_RE = /(!?)\[\[([^[\]\n]*)\]\]/g;
/** Tail of `[text](url "title")`, matched (sticky) at the `(` after `]`. */
const MD_TAIL_RE = /\(\s*(<[^>\n]*>|(?:[^()\s]|\([^()\s]*\))+)(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/y;
const TAG_CHAR_RE = /[\p{L}\p{N}]/u;
const HEADING_RE = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/;
const BLOCK_ID_TAIL_RE = /^[A-Za-z0-9-]+\s*$/;
const FENCE_RE = /^[ \t>]*(`{3,}|~{3,})(.*)$/;
const SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;
const SPECIAL_RE = /[`%$]/;
/** Characters any scanned construct needs; in the idle state the scanner jumps over lines without them. */
const INTERESTING_G = /[`~%$[#^]/g;

const NON_ASCII_RE = /[^\x00-\x7f]/;

/** NFC with a fast path: pure-ASCII strings are already normalized (String#normalize is comparatively slow). */
function nfc(s: string): string {
  return NON_ASCII_RE.test(s) ? nfcFull(s) : s;
}

const SPECIAL_G = /[\\`%$]/g;
const SPACES = ' '.repeat(256);
function spaces(n: number): string {
  return n <= 256 ? SPACES.slice(0, n) : ' '.repeat(n);
}

/** End index of the tag body starting at `start` (letters, digits, `_`, `-`, `/`; ASCII fast path). */
function tagBodyEnd(s: string, start: number): number {
  let i = start;
  for (; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if ((c >= 97 && c <= 122) || (c >= 65 && c <= 90) || (c >= 48 && c <= 57) || c === 95 || c === 45 || c === 47) continue;
    if (c < 128) break;
    const cp = s.codePointAt(i)!;
    if (!TAG_CHAR_RE.test(String.fromCodePoint(cp))) break;
    if (cp > 0xffff) i++;
  }
  return i;
}

/** Tags must contain at least one non-digit character. */
function isDigitsOnly(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 48 || c > 57) return c < 128 ? false : /^\p{N}+$/u.test(s);
  }
  return true;
}

function isWs(c: string | undefined): boolean {
  return c === undefined || c === ' ' || c === '\t';
}

interface MaskState {
  inComment: boolean;
  inMath: boolean;
}

/** Replaces inline code, comments and math in `line` by spaces (same length). Comment/math may span lines via `st`. */
function maskLine(line: string, st: MaskState): string {
  let out = '';
  let last = 0; // start of not-yet-copied text
  let i = 0;
  const n = line.length;
  while (i < n) {
    if (st.inComment) {
      const e = line.indexOf('%%', i);
      if (e < 0) { { out += line.slice(last, i) + spaces((n) - (i)); last = n; } break; }
      { out += line.slice(last, i) + spaces((e + 2) - (i)); last = e + 2; } i = e + 2; st.inComment = false; continue;
    }
    if (st.inMath) {
      const e = line.indexOf('$$', i);
      if (e < 0) { { out += line.slice(last, i) + spaces((n) - (i)); last = n; } break; }
      { out += line.slice(last, i) + spaces((e + 2) - (i)); last = e + 2; } i = e + 2; st.inMath = false; continue;
    }
    SPECIAL_G.lastIndex = i;
    const sm = SPECIAL_G.exec(line);
    if (!sm) break;
    i = sm.index;
    const c = line[i];
    if (c === '\\') { i += 2; continue; }
    if (c === '`') {
      let j = i;
      while (line[j] === '`') j++;
      const len = j - i;
      let k = j;
      let close = -1;
      while (k < n) {
        const p = line.indexOf('`', k);
        if (p < 0) break;
        let q = p;
        while (line[q] === '`') q++;
        if (q - p === len) { close = q; break; }
        k = q;
      }
      if (close >= 0) { { out += line.slice(last, i) + spaces((close) - (i)); last = close; } i = close; } else i = j;
      continue;
    }
    if (c === '%' && line[i + 1] === '%') { st.inComment = true; { out += line.slice(last, i) + spaces((i + 2) - (i)); last = i + 2; } i += 2; continue; }
    if (c === '$') {
      if (line[i + 1] === '$') { st.inMath = true; { out += line.slice(last, i) + spaces((i + 2) - (i)); last = i + 2; } i += 2; continue; }
      if (!isWs(line[i + 1])) {
        let e = i + 1;
        let close = -1;
        while ((e = line.indexOf('$', e)) >= 0) {
          if (line[e - 1] !== '\\' && !isWs(line[e - 1]) && !/[0-9]/.test(line[e + 1] ?? '')) { close = e + 1; break; }
          e++;
        }
        if (close >= 0) { { out += line.slice(last, i) + spaces((close) - (i)); last = close; } i = close; continue; }
      }
    }
    i++;
  }
  return last === 0 ? line : out + line.slice(last);
}

function decode(s: string): string {
  if (!s.includes('%')) return s;
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function splitList(v: unknown): string[] {
  if (v == null) return [];
  if (Array.isArray(v)) return v.flatMap(splitList);
  if (typeof v === 'string' || typeof v === 'number') return [String(v)];
  return [];
}

const TAGS_KEY_RE = /^tags\s*:/m;
const TAG_KEY_RE = /^tag\s*:/m;
const FM_KEY_RE = /^([A-Za-z_][A-Za-z0-9_-]*):(?:[ \t]+(\S.*?))?[ \t]*$/;
const FM_ITEM_RE = /^([ \t]*)-[ \t]+(\S.*?)[ \t]*$/;
const FM_RESERVED_RE = /^(?:true|false|null|yes|no|on|off|y|n)$/i;
const FM_DATE_RE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;
const FM_INT_RE = /^(?:0|[1-9]\d{0,14})$/;

/** Value of a plain scalar that is certainly what YAML 1.2 would give; `undefined` = not sure, use the YAML library. */
function fastScalar(v: string, inFlow: boolean): string | number | undefined {
  const c = v.charCodeAt(0);
  const letter = (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c > 127 && /^\p{L}/u.test(v));
  if (letter) {
    if (v.length <= 5 && FM_RESERVED_RE.test(v)) return undefined;
  } else if (c >= 48 && c <= 57) {
    if (FM_INT_RE.test(v)) return Number(v);
    if (!FM_DATE_RE.test(v)) return undefined;
  } else return undefined;
  if (v.includes(': ') || v.includes(' #') || v.endsWith(':') || v.includes('\t')) return undefined;
  if (inFlow && /[[\]{},]/.test(v)) return undefined;
  return v;
}

/**
 * Parses the common simple frontmatter shapes (`key: scalar`, `key: [a, b]`, `key:` + `- item` lines) without the
 * YAML library. Returns `undefined` for anything else (quotes, comments, nesting, duplicate keys, ...).
 */
function fastFrontmatter(src: string): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};
  const lines = src.split('\n');
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i]!;
    if (line.endsWith('\r')) line = line.slice(0, -1);
    if (line === '') continue;
    const m = FM_KEY_RE.exec(line);
    if (!m) return undefined;
    const key = m[1]!;
    if (key === '__proto__' || key in out || FM_RESERVED_RE.test(key)) return undefined;
    const raw = m[2];
    if (raw === undefined) {
      // block list
      const items: Array<string | number> = [];
      let indent: string | undefined;
      while (i + 1 < lines.length) {
        let next = lines[i + 1]!;
        if (next.endsWith('\r')) next = next.slice(0, -1);
        const im = FM_ITEM_RE.exec(next);
        if (!im) break;
        if (indent !== undefined && im[1] !== indent) return undefined;
        indent = im[1];
        const item = fastScalar(im[2]!, false);
        if (item === undefined) return undefined;
        items.push(item);
        i++;
      }
      if (items.length === 0) return undefined;
      out[key] = items;
    } else if (raw.charCodeAt(0) === 91) {
      if (!raw.endsWith(']')) return undefined;
      const inner = raw.slice(1, -1).trim();
      const items: Array<string | number> = [];
      if (inner !== '') {
        for (const part of inner.split(',')) {
          const item = fastScalar(part.trim(), true);
          if (item === undefined) return undefined;
          items.push(item);
        }
      }
      out[key] = items;
    } else {
      const v = fastScalar(raw, false);
      if (v === undefined) return undefined;
      out[key] = v;
    }
  }
  return out;
}

function frontmatterTags(fm: Record<string, unknown>, text: string, range: { from: number; to: number }): TagRef[] {
  const out: TagRef[] = [];
  for (const key of ['tags', 'tag']) {
    if (!(key in fm)) continue;
    const value = fm[key];
    const raw = typeof value === 'string' ? value.split(/[\s,]+/) : splitList(value);
    const keyPos = text.slice(range.from, range.to).search(key === 'tags' ? TAGS_KEY_RE : TAG_KEY_RE);
    let searchFrom = keyPos < 0 ? range.from : range.from + keyPos;
    for (const item of raw) {
      const tag = nfc(item.trim().replace(/^#/, ''));
      if (!tag) continue;
      const pos = text.indexOf(tag, searchFrom);
      if (pos >= 0 && pos + tag.length <= range.to) {
        out.push({ tag, from: pos, to: pos + tag.length, source: 'frontmatter' });
        searchFrom = pos + tag.length;
      } else {
        out.push({ tag, from: range.from, to: range.to, source: 'frontmatter' });
      }
    }
  }
  return out;
}

function frontmatterAliases(fm: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const key of ['aliases', 'alias']) {
    const v = fm[key];
    const items = typeof v === 'string' ? v.split(',') : splitList(v);
    for (const a of items) {
      const t = nfc(a.trim());
      if (t) out.push(t);
    }
  }
  return out;
}

/** Finds a frontmatter block at the very start (after optional BOM). `end` is the end of the closing delimiter. */
export function findFrontmatter(text: string, start: number): { from: number; to: number; yaml: string } | null {
  if (!text.startsWith('---', start)) return null;
  let pos = text.indexOf('\n', start);
  if (pos < 0 || text.slice(start + 3, pos).trim() !== '') return null;
  const yamlFrom = pos + 1;
  pos = yamlFrom;
  while (pos <= text.length) {
    let nl = text.indexOf('\n', pos);
    if (nl < 0) nl = text.length;
    let end = nl;
    if (text[end - 1] === '\r') end--;
    const line = text.slice(pos, end);
    const t = line.trimEnd();
    if (t === '---' || t === '...') {
      return { from: start, to: pos + t.length, yaml: text.slice(yamlFrom, pos) };
    }
    if (nl >= text.length) break;
    pos = nl + 1;
  }
  return null;
}

function parseLinks(raw: string, masked: string, base: number, lineNo: number, out: LinkRef[]): void {
  const first = out.length;
  let sorted = true; // wikilinks and markdown links are found in separate passes; sort only if they interleave
  let work = masked;
  if (masked.includes('[')) {
    // Wikilinks are blanked before the markdown pass, but only if there can be markdown links at all.
    const hasMd = masked.includes('](');
    let blanked = '';
    let copied = 0;
    if (masked.includes('[[')) {
      WIKI_RE.lastIndex = 0;
      for (let m: RegExpExecArray | null; (m = WIKI_RE.exec(masked)); ) {
        const inner = m[2] ?? '';
        const pipe = inner.indexOf('|');
        let path = pipe < 0 ? inner : inner.slice(0, pipe);
        if (pipe >= 0 && path.endsWith('\\')) path = path.slice(0, -1);
        const alias = pipe < 0 ? undefined : inner.slice(pipe + 1).trim();
        const hash = path.indexOf('#');
        const target = nfc((hash < 0 ? path : path.slice(0, hash)).trim());
        const subpath = hash < 0 ? undefined : path.slice(hash + 1).trim();
        if (!target && !subpath) continue;
        const ref: LinkRef = { kind: m[1] ? 'embed' : 'wikilink', target, raw: raw.slice(m.index, m.index + m[0].length), from: base + m.index, to: base + m.index + m[0].length, line: lineNo };
        if (subpath) ref.subpath = nfc(subpath);
        if (alias) ref.alias = alias;
        out.push(ref);
        if (hasMd) {
          blanked += masked.slice(copied, m.index) + spaces(m[0].length);
          copied = m.index + m[0].length;
        }
      }
      if (copied > 0) work = blanked + masked.slice(copied);
    }
    if (hasMd) {
      const wikiCount = out.length - first;
      for (let p = work.indexOf(']('); p >= 0; p = work.indexOf('](', p + 1)) {
        const p0 = p;
        const open = work.lastIndexOf('[', p);
        if (open < 0 || work.indexOf(']', open) !== p) continue;
        MD_TAIL_RE.lastIndex = p + 1;
        const t = MD_TAIL_RE.exec(work);
        if (!t) continue;
        const bang = open > 0 && work.charCodeAt(open - 1) === 33;
        const start = bang ? open - 1 : open;
        const end = p + 1 + t[0].length;
        p = end - 1;
        let url = t[1] ?? '';
        if (url.startsWith('<')) url = url.slice(1, -1);
        if ((url.includes(':') && SCHEME_RE.test(url)) || url.startsWith('//')) continue;
        const hash = url.indexOf('#');
        const target = nfc(decode(hash < 0 ? url : url.slice(0, hash)).trim());
        const subpath = hash < 0 ? '' : decode(url.slice(hash + 1)).trim();
        if (!target && !subpath) continue;
        const ref: LinkRef = { kind: bang ? 'embed' : 'markdown', target, raw: raw.slice(start, end), from: base + start, to: base + end, line: lineNo };
        if (subpath) ref.subpath = nfc(subpath);
        const text = work.slice(open + 1, p0);
        if (text) ref.alias = text;
        if (wikiCount > 0 && base + start < out[out.length - 1]!.from) sorted = false;
        out.push(ref);
      }
    }
  }
  if (!sorted) {
    const tail = out.splice(first).sort((a, b) => a.from - b.from);
    for (const l of tail) out.push(l);
  }
}

interface ScanCtx {
  result: ParsedNote;
  st: MaskState;
  fence: { ch: string; len: number } | null;
}

/** Cheap pre-check for FENCE_RE: first char after indentation / `>` markers is a backtick or tilde. */
function startsWithFence(line: string): boolean {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c === 32 || c === 9 || c === 62) continue;
    return c === 96 || c === 126;
  }
  return false;
}

function scanLine(ctx: ScanCtx, line: string, base: number, no: number): void {
  const { result, st } = ctx;
  if (ctx.fence) {
    const m = FENCE_RE.exec(line);
    if (m && m[1]![0] === ctx.fence.ch && m[1]!.length >= ctx.fence.len && m[2]!.trim() === '') ctx.fence = null;
    return;
  }
  if (!st.inComment && !st.inMath && startsWithFence(line)) {
    const m = FENCE_RE.exec(line);
    if (m && !(m[1]![0] === '`' && m[2]!.includes('`'))) {
      ctx.fence = { ch: m[1]![0]!, len: m[1]!.length };
      return;
    }
  }
  const masked = SPECIAL_RE.test(line) || st.inComment || st.inMath ? maskLine(line, st) : line;

  if (masked.includes('[')) parseLinks(line, masked, base, no, result.links);

  if (masked.includes('#')) {
    const c0 = masked.charCodeAt(0);
    const h = c0 === 35 || c0 === 32 ? HEADING_RE.exec(masked) : null;
    if (h) {
      // Heading text comes from the original line so masked code spans stay readable.
      const hashes = h[1]!.length;
      const idx = masked.indexOf('#');
      const textPart = line.slice(idx + hashes).replace(/[ \t]+#+[ \t]*$/, '').trim();
      result.headings.push({ level: hashes, text: nfc(textPart), line: no, from: base + idx } satisfies Heading);
    }
    for (let i = masked.indexOf('#'); i >= 0; i = masked.indexOf('#', i + 1)) {
      if (i > 0) {
        const pc = masked.charCodeAt(i - 1);
        if (pc !== 32 && pc !== 9 && !(pc >= 10 && pc <= 13) && !/\s/.test(masked[i - 1]!)) continue;
      }
      const e = tagBodyEnd(masked, i + 1);
      if (e === i + 1) continue;
      const body = masked.slice(i + 1, e);
      if (isDigitsOnly(body)) continue;
      result.tags.push({ tag: nfc(body), from: base + i, to: e + base, source: 'body' });
    }
  }

  const caret = masked.lastIndexOf('^');
  if (caret >= 0 && (caret === 0 || isWs(masked[caret - 1]) || /\s/.test(masked[caret - 1]!))) {
    const tail = masked.slice(caret + 1);
    if (BLOCK_ID_TAIL_RE.test(tail)) result.blockIds.push(tail.trimEnd());
  }
}

export function parseNote(text: string): ParsedNote {
  const result: ParsedNote = {
    links: [], tags: [], headings: [], blockIds: [],
    frontmatter: null, frontmatterRange: null, aliases: [],
  };
  const bom = text.charCodeAt(0) === 0xfeff ? 1 : 0;

  const fmBlock = findFrontmatter(text, bom);
  if (fmBlock) {
    result.frontmatterRange = { from: fmBlock.from, to: fmBlock.to };
    const fast = fastFrontmatter(fmBlock.yaml);
    if (fast) result.frontmatter = fast;
    else {
      try {
        const v: unknown = parseYaml(fmBlock.yaml, { logLevel: 'error' });
        if (v == null) result.frontmatter = {};
        else if (typeof v === 'object' && !Array.isArray(v)) result.frontmatter = v as Record<string, unknown>;
      } catch {
        result.frontmatter = null;
      }
    }
    if (result.frontmatter) {
      result.aliases = frontmatterAliases(result.frontmatter);
      result.tags.push(...frontmatterTags(result.frontmatter, text, result.frontmatterRange));
    }
  }

  const bodyStart = fmBlock ? fmBlock.to : 0;
  const st: MaskState = { inComment: false, inMath: false };
  const ctx: ScanCtx = { result, st, fence: null };
  let pos = 0;
  let lineNo = 0;
  const len = text.length;

  while (pos <= len) {
    if (pos >= bodyStart && !ctx.fence && !st.inComment && !st.inMath) {
      // Idle: jump straight to the next line that contains anything of interest (counting skipped lines).
      INTERESTING_G.lastIndex = pos;
      const hit = INTERESTING_G.exec(text);
      if (!hit) break;
      const lineStart = text.lastIndexOf('\n', hit.index) + 1;
      if (lineStart > pos) {
        for (let q = text.indexOf('\n', pos); q >= 0 && q < lineStart; q = text.indexOf('\n', q + 1)) lineNo++;
        pos = lineStart;
      }
    }
    let nl = text.indexOf('\n', pos);
    if (nl < 0) nl = len;
    let end = nl;
    if (end > pos && text.charCodeAt(end - 1) === 13) end--;
    if (pos >= bodyStart || end > bodyStart) {
      const start = lineNo === 0 ? pos + bom : pos;
      // Remaining part of the closing frontmatter line is empty by construction; skip lines inside the block.
      if (start >= bodyStart && !(fmBlock && start < bodyStart)) {
        const line = text.slice(start, end);
        scanLine(ctx, line, start, lineNo);
      }
    }
    if (nl >= len) break;
    pos = nl + 1;
    lineNo++;
  }
  return result;
}

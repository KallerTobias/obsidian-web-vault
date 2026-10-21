import { syntaxTree } from '@codemirror/language';
import { type EditorState, Facet, StateEffect } from '@codemirror/state';
import type { SyntaxNode } from '@lezer/common';
import { dirname, relativeTo } from '@shared/normalize';
import { resolveLink, type FileLookup } from '@shared/resolve';

/*
 * Live preview, inline part: which Markdown markup to hide and which text to format, computed from the
 * Lezer tree alone (no DOM), so it can be tested on a plain EditorState. Markup stays visible on every
 * line a selection range touches; formatting (marks, heading line classes) is always applied.
 */

/** What the live preview needs from the app. */
export interface LivePreviewContext {
  /** The current link lookup (called on every recompute: the vault changes). */
  lookup: () => FileLookup;
  /** Vault path of the note: links resolve relative to it. */
  path: string;
  /**
   * A link was clicked: `target` is the resolved path, or (when `unresolved`) the path as written,
   * relative to the vault root.
   */
  openLink: (target: string, subpath: string | undefined, newTab: boolean, unresolved: boolean) => void;
  /** Text of a vault note, for embeds `![[Notiz]]` (none: embedded notes fail to load). */
  loadNote?: (path: string) => Promise<string>;
  /** A `#tag` in a rendered block was clicked (none: nothing happens). */
  openTag?: (tag: string) => void;
}

export const livePreviewContext = Facet.define<LivePreviewContext, LivePreviewContext | null>({
  combine: (values) => values[0] ?? null,
});

/** Dispatch after the vault's link lookup changed: links (and embeds) are resolved again. */
export const refreshLinks = StateEffect.define<null>();

export interface DocRange {
  from: number;
  to: number;
}

export interface InlineMark extends DocRange {
  cls: string;
  attrs?: Record<string, string>;
}

export interface InlineDecorations {
  /** Markup to hide (each range within one line). */
  hide: DocRange[];
  /** Formatted text. */
  marks: InlineMark[];
  /** Classes for whole lines (headings), at the line start. */
  lines: { from: number; cls: string }[];
}

/** Formatting nodes: their class and the markers hidden outside the active lines. */
const FORMATS: Record<string, { cls: string; mark: string }> = {
  StrongEmphasis: { cls: 'cm-strong', mark: 'EmphasisMark' },
  Emphasis: { cls: 'cm-em', mark: 'EmphasisMark' },
  Strikethrough: { cls: 'cm-strikethrough', mark: 'StrikethroughMark' },
  Highlight: { cls: 'cm-highlight', mark: 'HighlightMark' },
  InlineCode: { cls: 'cm-inline-code', mark: 'CodeMark' },
};

/** Their content is no Markdown (or belongs to the block part of the live preview). */
const OPAQUE = new Set(['FencedCode', 'CodeBlock', 'InlineMath', 'BlockMath', 'HTMLBlock', 'CommentBlock', 'Image']);

const EXTERNAL_RE = /^(?:https?:|mailto:)/i;
/** Leading whitespace and control characters (browsers ignore them in front of a URL scheme). */
const LEADING_JUNK = /^[\u0000-\u0020]+/;

/** `url` if it may be opened from the editor (http, https, mailto only – never `javascript:` & co.), else null. */
export function safeExternalHref(url: string): string | null {
  const u = url.replace(LEADING_JUNK, '');
  return EXTERNAL_RE.test(u) ? u : null;
}
const SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;
const SPACE = /[ \t]/;

function decode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** Every line touched by a selection range (one range per selection range; they may overlap). */
export function activeLines(state: EditorState): DocRange[] {
  return state.selection.ranges.map((r) => ({ from: state.doc.lineAt(r.from).from, to: state.doc.lineAt(r.to).to }));
}

/**
 * Decorations for the inline live preview in `ranges` (default: the whole document), as a pure function
 * of the state (text, selection, syntax tree, `livePreviewContext`). The ranges must be sorted and
 * disjoint (as `EditorView.visibleRanges`).
 */
export function computeInlineDecorations(state: EditorState, ranges: readonly DocRange[] = [{ from: 0, to: state.doc.length }]): InlineDecorations {
  const out: InlineDecorations = { hide: [], marks: [], lines: [] };
  const doc = state.doc;
  const ctx = state.facet(livePreviewContext);
  const active = activeLines(state);
  const isActive = (n: DocRange) => active.some((a) => a.from <= n.to && n.from <= a.to);
  let lookup: FileLookup | undefined;
  const resolve = (target: string): string | null => {
    if (!ctx) return null;
    if (target === '') return ctx.path;
    lookup ??= ctx.lookup();
    return resolveLink(target, ctx.path, lookup);
  };

  const hide = (from: number, to: number) => {
    if (from < to && doc.lineAt(from).to >= to) out.hide.push({ from, to });
  };
  const mark = (from: number, to: number, cls: string, attrs?: Record<string, string>) => {
    if (from < to) out.marks.push(attrs ? { from, to, cls, attrs } : { from, to, cls });
  };
  /** A link to a vault note: class and attributes as the reading view's `a.internal-link`. */
  const internal = (target: string, subpath: string | undefined, unresolvedHref: string) => {
    const resolved = resolve(target);
    const attrs: Record<string, string> = { 'data-href': resolved ?? unresolvedHref };
    if (subpath) attrs['data-subpath'] = subpath;
    return { cls: resolved === null && ctx ? 'cm-internal-link is-unresolved' : 'cm-internal-link', attrs };
  };

  const wikiLink = (node: SyntaxNode) => {
    const inner = state.sliceDoc(node.from + 2, node.to - 2);
    const pipe = inner.indexOf('|');
    const linkPart = pipe < 0 ? inner : inner.slice(0, pipe);
    const alias = pipe < 0 ? '' : inner.slice(pipe + 1);
    const hash = linkPart.indexOf('#');
    const target = (hash < 0 ? linkPart : linkPart.slice(0, hash)).trim();
    const subpath = hash < 0 ? undefined : linkPart.slice(hash + 1).trim() || undefined;
    if (target === '' && subpath === undefined) return;
    // Shown: the alias, else the link as written.
    const [textFrom, textTo] = alias.trim() !== '' ? [node.from + 3 + pipe, node.to - 2] : [node.from + 2, node.from + 2 + linkPart.length];
    const { cls, attrs } = internal(target, subpath, target);
    mark(textFrom, textTo, cls, attrs);
    if (!isActive(node)) {
      hide(node.from, textFrom);
      hide(textTo, node.to);
    }
  };

  const markdownLink = (node: SyntaxNode) => {
    const marks = node.getChildren('LinkMark');
    const url = node.getChild('URL');
    if (marks.length < 2 || !url) return; // reference link: left as written
    const open = marks[0]!;
    const close = marks[1]!;
    const href = state.sliceDoc(url.from, url.to).replace(LEADING_JUNK, '').trim().replace(/^<(.*)>$/, '$1');
    const external = safeExternalHref(href);
    let link: { cls: string; attrs?: Record<string, string> };
    if (external !== null) link = { cls: 'cm-link', attrs: { 'data-href': external } };
    else if (SCHEME_RE.test(href) || href.startsWith('//') || href === '') link = { cls: 'cm-link' };
    else {
      const hash = href.indexOf('#');
      const target = decode(hash < 0 ? href : href.slice(0, hash));
      const subpath = hash < 0 ? undefined : decode(href.slice(hash + 1)) || undefined;
      // Unresolved: relative to the note's folder, so a click creates the note where the link expects it.
      link = internal(target, subpath, relativeTo(dirname(ctx?.path ?? ''), target));
    }
    mark(open.to, close.from, link.cls, link.attrs);
    if (!isActive(node)) {
      hide(node.from, open.to);
      hide(close.from, node.to);
    }
  };

  const bareUrl = (node: SyntaxNode) => {
    const url = state.sliceDoc(node.from, node.to);
    const href = safeExternalHref(/^www\./i.test(url) ? 'http://' + url : SCHEME_RE.test(url) ? url : 'mailto:' + url);
    // Other schemes (`javascript:`, `data:` …) look like links but cannot be opened.
    mark(node.from, node.to, 'cm-link', href === null ? undefined : { 'data-href': href });
  };

  const heading = (node: SyntaxNode, level: number) => {
    out.lines.push({ from: doc.lineAt(node.from).from, cls: `cm-h${level}` });
    if (isActive(node)) return;
    const marks = node.getChildren('HeaderMark');
    marks.forEach((m, i) => {
      if (i === 0 && m.from === node.from) {
        let end = m.to;
        while (end < node.to && SPACE.test(state.sliceDoc(end, end + 1))) end++;
        hide(m.from, end);
      } else {
        let start = m.from;
        while (start > node.from && SPACE.test(state.sliceDoc(start - 1, start))) start--;
        hide(start, m.to);
      }
    });
  };

  const tree = syntaxTree(state);
  let doneTo = -1;
  for (const range of ranges) {
    const seenBefore = doneTo;
    tree.iterate({
      from: range.from,
      to: range.to,
      enter: (ref) => {
        const name = ref.name;
        if (OPAQUE.has(name)) return false;
        // Started in an earlier range: handled there (descend anyway: containers span ranges).
        if (ref.from < seenBefore) return undefined;
        const node = ref.node;
        const format = FORMATS[name];
        if (format) {
          mark(node.from, node.to, format.cls);
          if (!isActive(node)) for (const m of node.getChildren(format.mark)) hide(m.from, m.to);
          return name === 'InlineCode' ? false : undefined;
        }
        switch (name) {
          case 'WikiLink':
            // Embeds `![[…]]` belong to the block part.
            if (state.sliceDoc(node.from, node.from + 1) !== '!') wikiLink(node);
            return false;
          case 'Link':
            markdownLink(node);
            return undefined; // the link text may be formatted
          case 'Autolink': {
            const url = node.getChild('URL');
            if (url) bareUrl(url);
            if (!isActive(node)) for (const m of node.getChildren('LinkMark')) hide(m.from, m.to);
            return false;
          }
          case 'URL':
            if (node.parent?.name !== 'Link') bareUrl(node);
            return false;
          case 'Tag':
            mark(node.from, node.to, 'cm-tag');
            return false;
          case 'ObsidianComment':
          case 'ObsidianCommentBlock':
            mark(node.from, node.to, 'cm-comment');
            return false;
          case 'Escape':
            if (!isActive(node)) hide(node.from, node.from + 1);
            return false;
        }
        const h = /^ATXHeading(\d)$/.exec(name);
        if (h) heading(node, Number(h[1]));
        return undefined;
      },
    });
    doneTo = Math.max(doneTo, range.to);
  }
  return out;
}

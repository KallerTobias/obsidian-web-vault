import { syntaxTree } from '@codemirror/language';
import {
  EditorSelection,
  EditorState,
  type Extension,
  type Range,
  StateEffect,
  StateField,
  type Text,
  Transaction,
  type TransactionSpec,
} from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate, WidgetType } from '@codemirror/view';
import type { SyntaxNode } from '@lezer/common';
import { basename } from '@shared/normalize';
import { resolveLink, type FileLookup } from '@shared/resolve';
import { de } from '../i18n/de';
import { embedKey, hydrateEmbeds, MAX_EMBEDS } from '../markdown/embeds';
import { renderMermaid } from '../markdown/mermaid';
import { fileUrl } from '../markdown/remark-obsidian';
import { renderMarkdown } from '../markdown/render';
import { mediaKind } from '../media';
import { activeLines, type DocRange, livePreviewContext, refreshLinks, safeExternalHref } from './inline-hide';
import { taskToggle } from './tasks';

/*
 * Live preview, block part: frontmatter (always hidden), task checkboxes, images, embeds, callouts, tables,
 * `$$` math, Mermaid diagrams and `---` lines are drawn as widgets while no selection range touches their
 * lines; touched, they show their source (the same rule as the inline part). Code blocks stay text.
 * Block decorations must come from a StateField; `computeBlockWidgets` is the pure part behind it.
 * Rendered widgets only ever hold HTML from `renderMarkdown` (sanitized) and the embed/Mermaid helpers.
 */

export type BlockKind = 'frontmatter' | 'checkbox' | 'image' | 'embed' | 'callout' | 'table' | 'math' | 'mermaid' | 'hr' | 'code';

export interface BlockWidgetSpec extends DocRange {
  kind: BlockKind;
  /** checkbox: ticked. */
  checked?: boolean;
  /** image/embed: the resolved vault path, null when the file does not exist. */
  target?: string | null;
  /** image: the path as written (shown when it is missing). */
  name?: string;
  alt?: string;
  width?: number;
  height?: number;
  /** embed: alone on its line at the top level, drawn as a block below the text flow. */
  block?: boolean;
}

/** Root class of every widget (the click handling and `live-preview.ts` recognise widgets by it). */
export const WIDGET_CLASS = 'cm-preview-widget';

/** Counters for tests: widgets drawn (`toDOM`) and Markdown renders (cache misses). */
export const blockWidgetStats = { drawn: 0, rendered: 0 };

/**
 * The frontmatter: from the document start to the start of the first body line (its line break
 * included), or null. Same rule as `findFrontmatter` (`---` line, closed by `---` or `...`), line-based so
 * positions are the document's (CRLF counts as one break there).
 */
export function frontmatterRange(doc: Text): DocRange | null {
  // Documents are immutable: filters, field and view plugin ask about the same one several times.
  const cached = frontmatterCache.get(doc);
  if (cached !== undefined) return cached;
  const fm = findRange(doc);
  frontmatterCache.set(doc, fm);
  return fm;
}
const frontmatterCache = new WeakMap<Text, DocRange | null>();

function findRange(doc: Text): DocRange | null {
  const first = doc.line(1).text;
  const open = first.charCodeAt(0) === 0xfeff ? first.slice(1) : first;
  if (!open.startsWith('---') || open.slice(3).trim() !== '') return null;
  let n = 1;
  for (const iter = doc.iterLines(2); !iter.next().done; ) {
    n++;
    const t = iter.value.trimEnd();
    if (t === '---' || t === '...') return { from: 0, to: n < doc.lines ? doc.line(n + 1).from : doc.length };
  }
  return null;
}

const CALLOUT_RE = /^>[ \t]*\[![^\]\s]+\]/;
const SIZE_RE = /^(\d+)(?:x(\d+))?$/;
const SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;
/** Not Markdown (or not ours): nothing inside becomes a widget. */
const OPAQUE = new Set(['CodeBlock', 'HTMLBlock', 'CommentBlock', 'ObsidianCommentBlock', 'InlineCode', 'InlineMath', 'ObsidianComment']);

function decode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function size(spec: string | undefined): { width?: number; height?: number } | null {
  const m = spec === undefined ? null : SIZE_RE.exec(spec.trim());
  if (!m) return null;
  return m[2] === undefined ? { width: Number(m[1]) } : { width: Number(m[1]), height: Number(m[2]) };
}

/**
 * The block widgets of `state` in `ranges` (default: the whole document; sorted, disjoint), as a pure
 * function of text, selection, syntax tree and `livePreviewContext`. Blocks a selection range touches are
 * left out (they show their source) – except the frontmatter, which is always hidden, and code blocks
 * (kind `code`: styled lines, never a widget). Multi-line blocks are only drawn at the top level.
 */
export function computeBlockWidgets(state: EditorState, ranges: readonly DocRange[] = [{ from: 0, to: state.doc.length }]): BlockWidgetSpec[] {
  const out: BlockWidgetSpec[] = [];
  const doc = state.doc;
  const fm = frontmatterRange(doc);
  if (fm) out.push({ from: fm.from, to: fm.to, kind: 'frontmatter' });
  const bodyStart = fm?.to ?? 0;
  const ctx = state.facet(livePreviewContext);
  const active = activeLines(state);
  const touched = (from: number, to: number) => active.some((a) => a.from <= to && from <= a.to);
  let lookup: FileLookup | undefined;
  const resolve = (target: string): string | null => {
    if (!ctx) return null;
    if (target === '') return ctx.path;
    lookup ??= ctx.lookup();
    return resolveLink(target, ctx.path, lookup);
  };

  /** Whole lines from the node's first to its last (a trailing line break is not a line of its own). */
  const lines = (node: SyntaxNode): DocRange => {
    const end = node.to > node.from && doc.lineAt(node.to).from === node.to ? node.to - 1 : node.to;
    return { from: doc.lineAt(node.from).from, to: doc.lineAt(end).to };
  };
  /** A multi-line block widget for `node`, when the selection is outside; false otherwise. */
  const block = (node: SyntaxNode, kind: BlockKind): boolean => {
    const r = lines(node);
    if (touched(r.from, r.to)) return false;
    out.push({ ...r, kind });
    return true;
  };

  const task = (node: SyntaxNode) => {
    const marker = node.getChild('TaskMarker');
    if (!marker || touched(marker.from, marker.to)) return;
    const listMark = node.parent?.getChild('ListMark');
    // Bullets are replaced together with the box; numbers stay.
    const from = listMark && /^[-*+]$/.test(state.sliceDoc(listMark.from, listMark.to)) ? listMark.from : marker.from;
    out.push({ from, to: marker.to, kind: 'checkbox', checked: state.sliceDoc(marker.from + 1, marker.from + 2) !== ' ' });
  };

  const wikiEmbed = (node: SyntaxNode) => {
    const inner = state.sliceDoc(node.from + 3, node.to - 2);
    const pipe = inner.indexOf('|');
    const linkPart = pipe < 0 ? inner : inner.slice(0, pipe);
    const alias = pipe < 0 ? undefined : inner.slice(pipe + 1).trim() || undefined;
    const hash = linkPart.indexOf('#');
    const target = (hash < 0 ? linkPart : linkPart.slice(0, hash)).trim();
    if (target === '' && hash < 0) return;
    // `![[https://…]]`: external, blocked by the CSP anyway – the source stays.
    if (SCHEME_RE.test(target) || target.startsWith('//')) return;
    if (touched(node.from, node.to)) return;
    const resolved = resolve(target);
    if (mediaKind(resolved ?? target) === 'image') {
      const dims = size(alias);
      const alt = !dims && alias ? alias : basename(resolved ?? target);
      out.push({ from: node.from, to: node.to, kind: 'image', target: resolved, name: target, alt, ...dims });
      return;
    }
    const line = doc.lineAt(node.from);
    const alone = line.from === node.from && line.to === node.to && node.parent?.name === 'Paragraph' && node.parent.parent?.name === 'Document';
    out.push({ from: node.from, to: node.to, kind: 'embed', target: resolved, ...(alone ? { block: true } : {}) });
  };

  const image = (node: SyntaxNode) => {
    const marks = node.getChildren('LinkMark');
    const url = node.getChild('URL');
    if (marks.length < 2 || !url) return;
    const href = state.sliceDoc(url.from, url.to).trim().replace(/^<(.*)>$/, '$1');
    // External images are blocked by the CSP anyway, other schemes are dropped: the source stays.
    if (SCHEME_RE.test(href) || href.startsWith('//') || href === '') return;
    if (touched(node.from, node.to)) return;
    let alt = state.sliceDoc(marks[0]!.to, marks[1]!.from);
    const sized = /^(.*?)\|(\d+(?:x\d+)?)$/.exec(alt);
    const dims = sized ? size(sized[2]) : null;
    if (sized) alt = sized[1]!;
    const resolved = ctx ? resolveLink(decode(href.split('#')[0]!), ctx.path, (lookup ??= ctx.lookup())) : null;
    out.push({ from: node.from, to: node.to, kind: 'image', target: resolved, name: href, alt, ...dims });
  };

  /** A paragraph that is just `$$…$$` on one line: display math, as in the reading view. */
  const displayMath = (node: SyntaxNode): boolean => {
    const only = node.firstChild;
    return !!only && only.name === 'InlineMath' && !only.nextSibling && only.from === node.from && only.to === node.to && state.sliceDoc(node.from, node.from + 2) === '$$';
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
        if (name === 'Document') return undefined;
        if (ref.from < bodyStart || OPAQUE.has(name)) return false;
        // Started in an earlier range: handled there.
        if (ref.from < seenBefore) return undefined;
        const node = ref.node;
        const top = node.parent?.name === 'Document';
        switch (name) {
          case 'FencedCode': {
            const info = node.getChild('CodeInfo');
            const lang = info ? state.sliceDoc(info.from, info.to).trim().toLowerCase() : '';
            if (!(lang === 'mermaid' && top && block(node, 'mermaid'))) out.push({ ...lines(node), kind: 'code' });
            return false;
          }
          case 'Table':
            return top && block(node, 'table') ? false : undefined;
          case 'BlockMath':
            if (top) block(node, 'math');
            return false;
          case 'HorizontalRule':
            if (top) block(node, 'hr');
            return false;
          case 'Blockquote':
            return top && CALLOUT_RE.test(doc.lineAt(node.from).text) && block(node, 'callout') ? false : undefined;
          case 'Paragraph':
            if (top && displayMath(node)) {
              block(node, 'math');
              return false;
            }
            return undefined;
          case 'Task':
            task(node);
            return undefined;
          case 'WikiLink':
            if (state.sliceDoc(node.from, node.from + 1) === '!') wikiEmbed(node);
            return false;
          case 'Image':
            image(node);
            return false;
        }
        return undefined;
      },
    });
    doneTo = Math.max(doneTo, range.to);
  }
  return out;
}

// --- widgets ------------------------------------------------------------------------------------

/** Rendered HTML per link lookup (a new lookup after vault changes starts afresh), note and block text. */
const htmlCache = new WeakMap<FileLookup, Map<string, string>>();
const HTML_CACHE_MAX = 500;

function renderCached(source: string, path: string, lookup: FileLookup): string {
  let cache = htmlCache.get(lookup);
  if (!cache) htmlCache.set(lookup, (cache = new Map()));
  const key = path + '\0' + source;
  let html = cache.get(key);
  if (html === undefined) {
    blockWidgetStats.rendered++;
    html = renderMarkdown(source, { path, lookup });
    if (cache.size >= HTML_CACHE_MAX) cache.clear();
    cache.set(key, html);
  }
  return html;
}

/** Per editor view: the embed budget (embeds shown at once) and the note texts loaded for embeds. */
interface ViewEmbeds {
  budget: { left: number };
  notes: Map<string, Promise<string>>;
}
const viewEmbeds = new WeakMap<EditorView, ViewEmbeds>();
/** Budget taken by the embeds inside one widget; given back when the widget's DOM goes away. */
const spentBy = new WeakMap<HTMLElement, { owner: ViewEmbeds; used: number; released: boolean }>();

/** Embeds the view may still show (tests). */
export const embedBudgetLeft = (view: EditorView): number => embedsOf(view).budget.left;

function embedsOf(view: EditorView): ViewEmbeds {
  let e = viewEmbeds.get(view);
  if (!e) viewEmbeds.set(view, (e = { budget: { left: MAX_EMBEDS }, notes: new Map() }));
  return e;
}

/** Folded callouts start collapsed (as in the reading view); Mermaid sources become diagrams. */
function finishRender(view: EditorView, root: HTMLElement): void {
  for (const c of root.querySelectorAll('.callout[data-fold="-"]')) c.classList.add('is-collapsed');
  if (root.querySelector('pre.mermaid-src'))
    void renderMermaid(root).then(
      () => view.requestMeasure(),
      () => {
        /* diagram library failed to load: the source stays visible */
      },
    );
}

function hydrate(view: EditorView, root: HTMLElement, path: string, lookup: FileLookup): void {
  if (!root.querySelector('.embed[data-embed]')) return;
  const owner = embedsOf(view);
  const spent = { owner, used: 0, released: false };
  spentBy.set(root, spent);
  // The view's budget, counting what this widget takes; nothing more once the widget is gone.
  const budget = {
    get left() {
      return spent.released ? 0 : owner.budget.left;
    },
    set left(v: number) {
      if (spent.released) return;
      spent.used += owner.budget.left - v;
      owner.budget.left = v;
    },
  };
  const loadNote = view.state.facet(livePreviewContext)?.loadNote;
  const load = (p: string) => {
    let text = owner.notes.get(p);
    if (!text) owner.notes.set(p, (text = loadNote ? loadNote(p) : Promise.reject(new Error('no loader'))));
    return text;
  };
  void hydrateEmbeds(root, { lookup, depth: 0, chain: [embedKey(path)], load, budget, afterRender: (el) => finishRender(view, el) }).then(() =>
    view.requestMeasure(),
  );
}

/** Events on audio/video controls belong to the browser, not the editor. */
const mediaEvent = (e: Event) => !!(e.target as Element | null)?.closest?.('audio, video');

const LINE_PX = 26;

/** A block (or embed) rendered through `renderMarkdown`. */
class RenderedWidget extends WidgetType {
  constructor(
    readonly kind: BlockKind,
    readonly source: string,
    readonly path: string,
    readonly lookup: FileLookup,
    readonly block: boolean,
  ) {
    super();
  }

  eq(other: RenderedWidget): boolean {
    return other.kind === this.kind && other.source === this.source && other.path === this.path && other.lookup === this.lookup && other.block === this.block;
  }

  get estimatedHeight(): number {
    if (!this.block) return -1;
    const lines = this.source.split('\n').length;
    switch (this.kind) {
      case 'mermaid':
        return 240;
      case 'embed':
        return 160;
      case 'table':
        return (lines - 1) * (LINE_PX + 8) + 16;
      default:
        return lines * LINE_PX + 16;
    }
  }

  toDOM(view: EditorView): HTMLElement {
    blockWidgetStats.drawn++;
    // Always a div: the rendered HTML holds block elements (an inline embed is drawn as an inline block).
    const root = document.createElement('div');
    root.className = `${WIDGET_CLASS} cm-${this.kind}-widget markdown${this.block ? '' : ' is-inline'}`;
    root.innerHTML = renderCached(this.source, this.path, this.lookup);
    finishRender(view, root);
    hydrate(view, root, this.path, this.lookup);
    return root;
  }

  destroy(dom: HTMLElement): void {
    const spent = spentBy.get(dom);
    if (!spent || spent.released) return;
    spent.released = true;
    spent.owner.budget.left += spent.used;
  }

  ignoreEvent(e: Event): boolean {
    return mediaEvent(e);
  }
}

class CheckboxWidget extends WidgetType {
  constructor(readonly checked: boolean) {
    super();
  }
  eq(other: CheckboxWidget): boolean {
    return other.checked === this.checked;
  }
  toDOM(): HTMLElement {
    blockWidgetStats.drawn++;
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.className = `${WIDGET_CLASS} cm-task-widget`;
    box.checked = this.checked;
    box.tabIndex = -1;
    return box;
  }
  ignoreEvent(): boolean {
    return false;
  }
}

class ImageWidget extends WidgetType {
  constructor(
    readonly target: string | null,
    readonly name: string,
    readonly alt: string,
    readonly width: number | undefined,
    readonly height: number | undefined,
  ) {
    super();
  }
  eq(o: ImageWidget): boolean {
    return o.target === this.target && o.name === this.name && o.alt === this.alt && o.width === this.width && o.height === this.height;
  }
  toDOM(view: EditorView): HTMLElement {
    blockWidgetStats.drawn++;
    if (this.target === null) {
      const missing = document.createElement('span');
      missing.className = `${WIDGET_CLASS} cm-image-missing`;
      missing.textContent = de.media.notFound(this.name);
      return missing;
    }
    const img = document.createElement('img');
    img.className = `${WIDGET_CLASS} cm-image-widget`;
    img.src = fileUrl(this.target);
    img.alt = this.alt;
    if (this.width !== undefined) img.setAttribute('width', String(this.width));
    if (this.height !== undefined) img.setAttribute('height', String(this.height));
    // Loading changes the line height.
    img.addEventListener('load', () => view.requestMeasure());
    return img;
  }
  ignoreEvent(): boolean {
    return false;
  }
}

class RuleWidget extends WidgetType {
  eq(): boolean {
    return true;
  }
  get estimatedHeight(): number {
    return LINE_PX;
  }
  toDOM(): HTMLElement {
    blockWidgetStats.drawn++;
    const root = document.createElement('div');
    root.className = `${WIDGET_CLASS} cm-hr-widget`;
    root.append(document.createElement('hr'));
    return root;
  }
  ignoreEvent(): boolean {
    return false;
  }
}

// --- state field --------------------------------------------------------------------------------

/** Set the part of the document to decorate (the viewport plus a margin; reported by the view). */
export const setBlockRange = StateEffect.define<DocRange>();

export interface BlockPreviewState {
  /** Decorated part; null: the whole document (until the view reports its viewport). */
  range: DocRange | null;
  specs: BlockWidgetSpec[];
  decorations: DecorationSet;
}

const hiddenFrontmatter = Decoration.replace({});
const codeLine = Decoration.line({ class: 'cm-codeblock' });
const rule = new RuleWidget();

function decorate(state: EditorState, specs: readonly BlockWidgetSpec[]): DecorationSet {
  const ctx = state.facet(livePreviewContext);
  const lookup = ctx?.lookup();
  const path = ctx?.path ?? '';
  const decos: Range<Decoration>[] = [];
  const rendered = (s: BlockWidgetSpec, block: boolean) =>
    lookup
      ? decos.push(Decoration.replace({ widget: new RenderedWidget(s.kind, state.doc.sliceString(s.from, s.to), path, lookup, block), block }).range(s.from, s.to))
      : 0;
  for (const s of specs) {
    switch (s.kind) {
      case 'frontmatter':
        if (s.from < s.to) decos.push(hiddenFrontmatter.range(s.from, s.to));
        break;
      case 'checkbox':
        decos.push(Decoration.replace({ widget: new CheckboxWidget(!!s.checked) }).range(s.from, s.to));
        break;
      case 'image':
        decos.push(Decoration.replace({ widget: new ImageWidget(s.target ?? null, s.name ?? '', s.alt ?? '', s.width, s.height) }).range(s.from, s.to));
        break;
      case 'embed':
        rendered(s, !!s.block);
        break;
      case 'callout':
      case 'table':
      case 'math':
      case 'mermaid':
        rendered(s, true);
        break;
      case 'hr':
        decos.push(Decoration.replace({ widget: rule, block: true }).range(s.from, s.to));
        break;
      case 'code':
        for (let pos = s.from; pos <= s.to; ) {
          const line = state.doc.lineAt(pos);
          decos.push(codeLine.range(line.from));
          pos = line.to + 1;
        }
        break;
    }
  }
  return Decoration.set(decos, true);
}

function build(state: EditorState, range: DocRange | null): BlockPreviewState {
  const r = range && { from: Math.min(range.from, state.doc.length), to: Math.min(range.to, state.doc.length) };
  const specs = computeBlockWidgets(state, r ? [r] : undefined);
  return { range: r, specs, decorations: decorate(state, specs) };
}

/** Recomputed when text, selection, syntax tree, decorated range or the vault's links change. */
export const blockPreviewField = StateField.define<BlockPreviewState>({
  create: (state) => build(state, null),
  update(value, tr) {
    let range = value.range;
    if (range && tr.docChanged) range = { from: tr.changes.mapPos(range.from, -1), to: tr.changes.mapPos(range.to, 1) };
    let reported = false;
    for (const e of tr.effects) {
      if (e.is(setBlockRange)) {
        range = e.value;
        reported = true;
      }
    }
    if (
      reported ||
      tr.docChanged ||
      tr.selection ||
      syntaxTree(tr.startState) !== syntaxTree(tr.state) ||
      tr.effects.some((e) => e.is(refreshLinks))
    )
      return build(tr.state, range);
    return value;
  },
  provide: (f) => EditorView.decorations.from(f, (v) => v.decorations),
});

// --- frontmatter guards -------------------------------------------------------------------------

/** No selection inside the hidden frontmatter: positions there move to the start of the body. */
const selectionOutOfFrontmatter = EditorState.transactionFilter.of((tr) => {
  if (!tr.selection && !tr.docChanged) return tr;
  const fm = frontmatterRange(tr.newDoc);
  const sel = tr.newSelection;
  if (!fm || sel.ranges.every((r) => r.from >= fm.to)) return tr;
  const clamp = (pos: number) => Math.max(pos, fm.to);
  return [tr, { selection: EditorSelection.create(sel.ranges.map((r) => EditorSelection.range(clamp(r.anchor), clamp(r.head))), sel.mainIndex), sequential: true }];
});

const USER_EDIT = /^(?:input|delete|move)(?:\.|$)/;

/**
 * Typing, deleting and drag-and-drop leave the hidden frontmatter (and its line break) alone: a user edit
 * that touches it is dropped as a whole (half of a multi-change command such as „Zeile verschieben“ would
 * corrupt the note). Inserting right at the body start is fine. Other transactions (reload from disk,
 * properties panel) are not filtered.
 */
const protectFrontmatter = EditorState.changeFilter.of((tr) => {
  if (!tr.docChanged || !USER_EDIT.test(tr.annotation(Transaction.userEvent) ?? '')) return true;
  const fm = frontmatterRange(tr.startState.doc);
  if (!fm) return true;
  let touches = false;
  tr.changes.iterChangedRanges((fromA) => {
    if (fromA < fm.to) touches = true;
  });
  return !touches;
});

/**
 * Nothing after the closing fence (no line break): typed text would extend the `---` line, so it starts
 * on a new line instead.
 */
const typeBelowFrontmatter = EditorState.transactionFilter.of((tr) => {
  if (!tr.docChanged || !USER_EDIT.test(tr.annotation(Transaction.userEvent) ?? '')) return tr;
  const doc = tr.startState.doc;
  const fm = frontmatterRange(doc);
  if (!fm || fm.to !== doc.length) return tr;
  let insertion: { text: string } | null = null;
  let other = false;
  tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    if (fromA === fm.to && toA === fm.to && !insertion) insertion = { text: inserted.toString() };
    else other = true;
  });
  const ins = insertion as { text: string } | null;
  if (!ins || other || ins.text.startsWith('\n')) return tr;
  const insert = '\n' + ins.text;
  return {
    changes: { from: fm.to, insert },
    selection: EditorSelection.cursor(fm.to + insert.length),
    userEvent: tr.annotation(Transaction.userEvent),
    scrollIntoView: tr.scrollIntoView,
  };
});

// --- view: reported range, clicks, theme --------------------------------------------------------

/** Lines decorated beyond the viewport on either side, so scrolling does not reveal undecorated blocks. */
const MARGIN_LINES = 100;

function withMargin(doc: Text, vp: DocRange): DocRange {
  const first = Math.max(1, doc.lineAt(vp.from).number - MARGIN_LINES);
  const last = Math.min(doc.lines, doc.lineAt(vp.to).number + MARGIN_LINES);
  return { from: doc.line(first).from, to: doc.line(last).to };
}

/**
 * Reports the viewport (with margin) to the state field when it leaves the decorated range, and moves a
 * selection out of the frontmatter (e.g. the initial cursor at 0). Dispatches after the current update.
 */
const viewportReporter = ViewPlugin.fromClass(
  class {
    destroyed = false;
    pending = false;
    constructor(readonly view: EditorView) {
      this.schedule();
    }
    update(u: ViewUpdate): void {
      // Embedded notes may have changed in the vault: load them afresh.
      if (u.transactions.some((t) => t.effects.some((e) => e.is(refreshLinks)))) viewEmbeds.get(u.view)?.notes.clear();
      if (u.viewportChanged || u.docChanged || u.selectionSet) this.schedule();
    }
    wanted(): TransactionSpec | null {
      const state = this.view.state;
      const range = state.field(blockPreviewField).range;
      const vp = this.view.viewport;
      const effects = !range || vp.from < range.from || vp.to > range.to ? [setBlockRange.of(withMargin(state.doc, vp))] : [];
      const fm = frontmatterRange(state.doc);
      const inFrontmatter = !!fm && state.selection.ranges.some((r) => r.from < fm.to);
      if (effects.length === 0 && !inFrontmatter) return null;
      // Setting the selection again runs it through `selectionOutOfFrontmatter`.
      return inFrontmatter ? { effects, selection: state.selection } : { effects };
    }
    schedule(): void {
      if (this.pending || !this.wanted()) return;
      this.pending = true;
      queueMicrotask(() => {
        this.pending = false;
        if (this.destroyed) return;
        const spec = this.wanted();
        if (spec) this.view.dispatch(spec);
      });
    }
    destroy(): void {
      this.destroyed = true;
    }
  },
);

function openWidgetLink(view: EditorView, a: HTMLAnchorElement, newTab: boolean): void {
  const ctx = view.state.facet(livePreviewContext);
  if (a.classList.contains('tag')) {
    if (a.dataset.tag) ctx?.openTag?.(a.dataset.tag);
    return;
  }
  if (a.classList.contains('internal-link') && a.dataset.href) {
    ctx?.openLink(a.dataset.href, a.dataset.subpath || undefined, newTab, a.classList.contains('is-unresolved'));
    return;
  }
  const safe = safeExternalHref(a.getAttribute('href') ?? '');
  if (safe !== null) window.open(safe, '_blank', 'noopener,noreferrer');
}

/** Ticks/unticks the task a checkbox in a widget belongs to; only that one character changes. */
function toggleTask(view: EditorView, root: HTMLElement, box: HTMLInputElement): void {
  if (view.state.readOnly) return;
  const doc = view.state.doc;
  let line = doc.lineAt(view.posAtDOM(root));
  if (box !== root) {
    // A task inside a rendered block: `data-line` counts from the block's first line. Embedded notes' tasks are not ours.
    const rel = Number(box.dataset.line);
    if (box.closest('.embed-content') || box.dataset.line === undefined || !Number.isInteger(rel) || rel < 0) return;
    if (line.number + rel > doc.lines) return;
    line = doc.line(line.number + rel);
  }
  const c = taskToggle(line.text, 0);
  if (c) view.dispatch({ changes: { from: line.from + c.from, to: line.from + c.to, insert: c.insert }, userEvent: 'input' });
}

const widgetRoot = (view: EditorView, e: Event): HTMLElement | null => {
  const root = (e.target as Element | null)?.closest?.<HTMLElement>('.' + WIDGET_CLASS) ?? null;
  return root && view.contentDOM.contains(root) ? root : null;
};

/**
 * Clicks on widgets: links open (Mod/middle click: new tab), checkboxes toggle their task, anything else
 * puts the cursor at the block start, which reveals the source.
 */
const widgetClicks = EditorView.domEventHandlers({
  mousedown(e, view) {
    if (e.button !== 0 && e.button !== 1) return false;
    const root = widgetRoot(view, e);
    if (!root) return false;
    const target = e.target as Element;
    const link = target.closest('a');
    if (link && root.contains(link)) {
      openWidgetLink(view, link, e.ctrlKey || e.metaKey || e.button === 1);
      return true;
    }
    if (e.button !== 0) return true;
    const box = target.closest<HTMLInputElement>('input[type="checkbox"]');
    if (box && root.contains(box)) {
      toggleTask(view, root, box);
      return true;
    }
    view.dispatch({ selection: EditorSelection.cursor(view.posAtDOM(root)), userEvent: 'select.pointer' });
    view.focus();
    return true;
  },
  // Handled on mousedown: no navigation, no native checkbox toggle (the text decides).
  click(e, view) {
    return !!widgetRoot(view, e) && !!(e.target as Element).closest('a, input');
  },
  // Middle click: opened on mousedown already; the browser must not open the link a second time.
  auxclick(e, view) {
    return !!widgetRoot(view, e) && !!(e.target as Element).closest('a');
  },
});

const theme = EditorView.theme({
  [`div.${WIDGET_CLASS}`]: { padding: '0.25em 0' },
  [`div.${WIDGET_CLASS}.is-inline`]: { display: 'inline-block', padding: '0', verticalAlign: 'top', maxWidth: '100%' },
  '.cm-hr-widget hr': { border: '0', borderTop: '1px solid var(--background-modifier-border)', margin: '0.6em 0' },
  '.cm-task-widget': { margin: '0 0.4em 0 0', verticalAlign: 'middle', cursor: 'pointer' },
  '.cm-image-widget': { maxWidth: '100%', height: 'auto', verticalAlign: 'bottom' },
  '.cm-image-missing': {
    color: 'var(--text-faint)',
    fontSize: '0.875em',
    border: '1px dashed var(--background-modifier-border)',
    borderRadius: 'var(--radius-s)',
    padding: '0 0.4em',
  },
  '.cm-line.cm-codeblock': {
    fontFamily: 'var(--font-monospace)',
    fontSize: '0.875em',
    backgroundColor: 'var(--background-secondary)',
  },
});

/** The block part of the live preview (see the top of this file). */
export function blockPreview(): Extension {
  return [blockPreviewField, selectionOutOfFrontmatter, typeBelowFrontmatter, protectFrontmatter, viewportReporter, widgetClicks, theme];
}

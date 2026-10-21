import { syntaxTree } from '@codemirror/language';
import { EditorSelection, type Extension, type Range } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view';
import type { SyntaxNode } from '@lezer/common';
import { blockPreview, WIDGET_CLASS } from './block-widgets';
import { computeInlineDecorations, livePreviewContext, refreshLinks, safeExternalHref, type LivePreviewContext } from './inline-hide';

export { livePreviewContext, refreshLinks, type LivePreviewContext } from './inline-hide';

/** Hidden markup: replaced by nothing (no widget), so the cursor steps over it like over one character. */
const hidden = Decoration.replace({});
const lineDecos = new Map<string, Decoration>();
const lineDeco = (cls: string) => {
  let d = lineDecos.get(cls);
  if (!d) lineDecos.set(cls, (d = Decoration.line({ class: cls })));
  return d;
};

function buildInline(view: EditorView): DecorationSet {
  const r = computeInlineDecorations(view.state, view.visibleRanges);
  const decos: Range<Decoration>[] = [];
  for (const l of r.lines) decos.push(lineDeco(l.cls).range(l.from));
  for (const m of r.marks) decos.push(Decoration.mark({ class: m.cls, attributes: m.attrs }).range(m.from, m.to));
  for (const h of r.hide) decos.push(hidden.range(h.from, h.to));
  return Decoration.set(decos, true);
}

/** Recomputed only when text, selection, visible part, parse progress or the vault's links changed. */
const inlinePreview = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildInline(view);
    }
    update(u: ViewUpdate) {
      if (
        u.docChanged ||
        u.selectionSet ||
        u.viewportChanged ||
        syntaxTree(u.startState) !== syntaxTree(u.state) ||
        u.transactions.some((t) => t.effects.some((e) => e.is(refreshLinks)))
      )
        this.decorations = buildInline(u.view);
    }
  },
  { decorations: (p) => p.decorations },
);

const LINK_NODES = new Set(['WikiLink', 'Link', 'Autolink', 'URL']);
/** Pointer movement (px) after which a press on a link is a drag (text selection), not a click. */
const DRAG_DISTANCE = 4;

/** The link syntax node around `pos` (the whole `[[…]]`, `[…](…)`, `<…>` or bare URL). */
function linkRange(view: EditorView, pos: number): { from: number; to: number } | null {
  for (let n: SyntaxNode | null = syntaxTree(view.state).resolveInner(pos, 1); n; n = n.parent) {
    if (!LINK_NODES.has(n.name)) continue;
    const outer = n.name === 'URL' && n.parent && LINK_NODES.has(n.parent.name) ? n.parent : n;
    return { from: outer.from, to: outer.to };
  }
  return null;
}

function posAt(view: EditorView, e: MouseEvent): number | null {
  try {
    return view.posAtCoords({ x: e.clientX, y: e.clientY }, false);
  } catch {
    return null; // no layout (tests)
  }
}

function follow(view: EditorView, el: HTMLElement, newTab: boolean): void {
  const href = el.dataset.href!;
  if (el.classList.contains('cm-link')) {
    // Checked again here: only http(s)/mailto ever reach window.open.
    const safe = safeExternalHref(href);
    if (safe !== null) window.open(safe, '_blank', 'noopener,noreferrer');
    return;
  }
  view.state.facet(livePreviewContext)?.openLink(href, el.dataset.subpath, newTab, el.classList.contains('is-unresolved'));
}

/**
 * Clicking a rendered link opens it – unless the cursor is already inside that link (then the click
 * edits as usual). Mod-click or middle click: new tab. A press that turns into a drag selects text.
 */
const linkClicks = EditorView.domEventHandlers({
  mousedown(e, view) {
    if (e.shiftKey || e.altKey || (e.button !== 0 && e.button !== 1)) return false;
    const el = (e.target as HTMLElement | null)?.closest<HTMLElement>('[data-href]');
    // Links in rendered blocks (widgets) are handled by the block preview.
    if (!el || !view.contentDOM.contains(el) || el.closest('.' + WIDGET_CLASS)) return false;
    const newTab = e.ctrlKey || e.metaKey || e.button === 1;
    const at = view.posAtDOM(el);
    const link = linkRange(view, at);
    if (!newTab && link && view.state.selection.ranges.some((r) => r.from < link.to && r.to > link.from)) return false;
    e.preventDefault();
    if (e.button === 1) {
      follow(view, el, true);
      return true;
    }
    const anchor = posAt(view, e) ?? at;
    let dragging = false;
    const move = (m: MouseEvent) => {
      if (!dragging && Math.hypot(m.clientX - e.clientX, m.clientY - e.clientY) < DRAG_DISTANCE) return;
      dragging = true;
      const head = posAt(view, m);
      if (head !== null) view.dispatch({ selection: EditorSelection.range(anchor, head), userEvent: 'select.pointer' });
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      if (dragging) view.focus();
      else follow(view, el, newTab);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    return true;
  },
});

/** Live-preview marks look like the reading view (`styles/markdown.css`). */
const theme = EditorView.theme({
  '.cm-line.cm-h1, .cm-line.cm-h2, .cm-line.cm-h3, .cm-line.cm-h4, .cm-line.cm-h5, .cm-line.cm-h6': { fontWeight: '650', lineHeight: '1.25' },
  '.cm-line.cm-h1': { fontSize: '1.8em', paddingTop: '0.4em' },
  '.cm-line.cm-h2': { fontSize: '1.5em', paddingTop: '0.3em' },
  '.cm-line.cm-h3': { fontSize: '1.25em', paddingTop: '0.2em' },
  '.cm-line.cm-h4': { fontSize: '1.1em' },
  '.cm-line.cm-h5': { fontSize: '0.83em' },
  '.cm-line.cm-h6': { fontSize: '0.67em' },
  '.cm-strong': { fontWeight: '700' },
  '.cm-em': { fontStyle: 'italic' },
  '.cm-strikethrough': { textDecoration: 'line-through' },
  '.cm-highlight': { backgroundColor: 'rgba(255, 208, 0, 0.4)', padding: '0 1px' },
  '.cm-inline-code': {
    fontFamily: 'var(--font-monospace)',
    fontSize: '0.875em',
    padding: '0.1em 0.3em',
    borderRadius: 'var(--radius-s)',
    backgroundColor: 'var(--background-secondary)',
  },
  '.cm-link, .cm-internal-link': { color: 'var(--text-accent)', cursor: 'pointer' },
  '.cm-link': { textDecoration: 'underline', textDecorationThickness: '1px', textUnderlineOffset: '2px' },
  '.cm-internal-link:hover': { textDecoration: 'underline' },
  '.cm-internal-link.is-unresolved': { opacity: '0.6' },
  '.cm-tag': {
    display: 'inline-block',
    color: 'var(--text-accent)',
    padding: '0 0.5em',
    borderRadius: '1em',
    backgroundColor: 'var(--text-selection)',
    fontSize: '0.875em',
  },
  '.cm-comment': { color: 'var(--text-faint)' },
});

/**
 * The live preview (mode „Bearbeiten“): inline formatting rendered in place, markup revealed on the lines
 * the selection touches; blocks (tables, callouts, math, images, embeds …) drawn as widgets while the
 * selection is outside them, the frontmatter always hidden (`block-widgets.ts`).
 */
export function livePreview(ctx: LivePreviewContext): Extension {
  return [livePreviewContext.of(ctx), blockPreview(), inlinePreview, linkClicks, theme];
}

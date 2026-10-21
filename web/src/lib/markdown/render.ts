import type { Element, Root as HastRoot } from 'hast';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize, { defaultSchema, type Options as Schema } from 'rehype-sanitize';
import rehypeStringify from 'rehype-stringify';
import { gfmFootnoteFromMarkdown } from 'mdast-util-gfm-footnote';
import { gfmStrikethroughFromMarkdown } from 'mdast-util-gfm-strikethrough';
import { gfmTableFromMarkdown } from 'mdast-util-gfm-table';
import { gfmTaskListItemFromMarkdown } from 'mdast-util-gfm-task-list-item';
import { gfmFootnote } from 'micromark-extension-gfm-footnote';
import { gfmStrikethrough } from 'micromark-extension-gfm-strikethrough';
import { gfmTable } from 'micromark-extension-gfm-table';
import { gfmTaskListItem } from 'micromark-extension-gfm-task-list-item';
import remarkMath from 'remark-math';
import remarkParse from 'remark-parse';
import remarkRehype from 'remark-rehype';
import katex from 'katex';
import { unified, type Processor } from 'unified';
import { VFile } from 'vfile';
import remarkObsidian, { prepareSource, type RenderContext } from './remark-obsidian';

export { subpathId, type RenderContext } from './remark-obsidian';

/*
 * Pipeline: remark-parse → GFM (bare URLs: see remarkGfmLite) → math → Obsidian syntax → mdast→hast (raw HTML kept as `raw`) →
 * task line numbers → raw HTML parsed (only if there is any) → **sanitize** → link/image hardening →
 * KaTeX → HTML string.
 *
 * KaTeX runs *after* sanitizing: its input is the text of `code.math-*` elements that survived the
 * sanitizer, and its output (with `trust: false`, so no \href, \htmlClass, \includegraphics …) is
 * generated markup we trust. Sanitizing after KaTeX would need `style` and dozens of classes on
 * every element — exactly the attributes we must refuse on the note author's own HTML.
 */

const base = defaultSchema.attributes!;
const withoutClass = (list: NonNullable<typeof base[string]>) =>
  list.filter((a) => !(Array.isArray(a) && a[0] === 'className'));

/** GitHub's schema plus the markup our Obsidian plugin produces (and nothing else). */
const schema: Schema = {
  ...defaultSchema,
  tagNames: [...defaultSchema.tagNames!, 'mark'],
  // Dropped together with their content (other unknown elements are unwrapped, their text kept).
  strip: ['script', 'style', 'template', 'iframe', 'frame', 'object', 'embed', 'noscript', 'noembed', 'noframes', 'textarea', 'select', 'title', 'xmp', 'svg', 'math'],
  attributes: {
    ...base,
    a: [...withoutClass(base.a!), ['className', 'internal-link', 'is-unresolved', 'tag', 'data-footnote-backref'], 'dataHref', 'dataSubpath', 'dataTag'],
    code: [['className', /^language-./, 'math-inline', 'math-display']],
    pre: [['className', 'mermaid-src']],
    div: [...base.div!, ['className', 'callout', 'callout-title', 'callout-content', 'embed'], 'dataCallout', 'dataFold', 'dataEmbed', 'dataSubpath'],
    span: [['className', 'embed'], 'dataEmbed', 'dataSubpath'],
    input: [['type', 'checkbox'], ['disabled', true], 'dataLine'],
  },
  protocols: { ...defaultSchema.protocols, href: ['http', 'https', 'mailto'], src: ['http', 'https'] },
  // Task checkboxes in the note itself are clickable (GitHub forces `disabled`).
  required: { input: { type: 'checkbox' } },
};

const classes = (el: Element): unknown[] => (Array.isArray(el.properties.className) ? el.properties.className : []);

type HastParent = HastRoot | Element;

/** Pre-order walk over elements with their parent and index; the callback returns the next index to visit. */
function walkElements(parent: HastParent, fn: (el: Element, parent: HastParent, index: number) => number | void): void {
  const kids = parent.children;
  for (let i = 0; i < kids.length; i++) {
    const node = kids[i]!;
    if (node.type !== 'element') continue;
    const next = fn(node, parent, i);
    if (typeof next === 'number') {
      i = next - 1;
      continue;
    }
    walkElements(node, fn);
    if (node.tagName === 'template' && node.content) walkElements(node.content as unknown as HastRoot, fn);
  }
}

/** Tags a note's own inline HTML may use; everything else from raw HTML is unwrapped (text kept). */
const RAW_TAGS = new Set(['b', 'i', 'br', 'sup', 'sub', 'kbd', 'details', 'summary', 'span', 'div', 'mark']);
/** Raw HTML elements dropped together with their content. */
const RAW_DROP = new Set(['script', 'style', 'template', 'iframe', 'frame', 'frameset', 'object', 'embed', 'noscript', 'noembed', 'noframes', 'textarea', 'select', 'option', 'title', 'xmp', 'svg', 'math', 'head', 'link', 'meta', 'base']);

/**
 * Marks elements built from Markdown before raw HTML is parsed, so elements that came from the note's raw
 * HTML can be told apart afterwards. A per-session random value: a note cannot forge it.
 */
const TRUST_MARK = Array.from(globalThis.crypto.getRandomValues(new Uint32Array(4)), (n) => n.toString(36)).join('');

function markTrusted(parent: HastParent): void {
  for (const node of parent.children) {
    if (node.type !== 'element') continue;
    node.properties.dataVwTrusted = TRUST_MARK;
    markTrusted(node);
  }
}

/**
 * Elements from raw HTML keep only the inline subset, with no attributes at all (`open` on `<details>`
 * aside): no class/`data-*`/id/href/src/style, so a note cannot fake app controls (internal links, embeds,
 * task checkboxes), load vault files or restyle the page. Other tags are unwrapped, dangerous ones dropped.
 */
function restrictRaw(parent: HastParent): void {
  const kids = parent.children;
  for (let i = 0; i < kids.length; i++) {
    const node = kids[i]!;
    if (node.type !== 'element') continue;
    if (node.properties.dataVwTrusted === TRUST_MARK) {
      delete node.properties.dataVwTrusted;
      restrictRaw(node);
      continue;
    }
    if (RAW_DROP.has(node.tagName)) {
      kids.splice(i--, 1);
      continue;
    }
    if (!RAW_TAGS.has(node.tagName)) {
      const inner = node.tagName === 'template' ? [] : node.children;
      kids.splice(i--, 1, ...inner);
      continue;
    }
    const open = node.tagName === 'details' && node.properties.open !== undefined && node.properties.open !== false;
    node.properties = open ? { open: true } : {};
    restrictRaw(node);
  }
}

/**
 * Before raw HTML is parsed: task checkboxes get their 0-based source line and become clickable in the
 * note itself (disabled in embeds). Raw HTML is only parsed when there is any (rehype-raw is slow), and
 * then restricted (see `restrictRaw`).
 */
function rehypeTasksAndRaw() {
  const raw = rehypeRaw();
  return (tree: HastRoot, file: VFile) => {
    const depth = file.data.obsidian?.depth ?? 0;
    let hasRaw = false;
    const scan = (parent: HastParent, line: number | undefined): void => {
      for (const node of parent.children) {
        if (node.type === 'raw') hasRaw = true;
        if (node.type !== 'element') continue;
        if (node.tagName === 'li' && classes(node).includes('task-list-item')) {
          scan(node, node.position?.start.line);
          continue;
        }
        if (node.tagName === 'input' && node.properties.type === 'checkbox' && line !== undefined && depth === 0) {
          delete node.properties.disabled;
          node.properties.dataLine = line - 1;
          line = undefined; // only the item's own checkbox
        }
        scan(node, line);
      }
    };
    scan(tree, undefined);
    if (!hasRaw) return tree;
    markTrusted(tree);
    const parsed = raw(tree, file) as HastRoot;
    restrictRaw(parsed);
    return parsed;
  };
}

const EXTERNAL_RE = /^(?:https?:|mailto:)/i;
const VAULT_FILE_PREFIX = '/api/file?path=';
const CLOBBER = 'user-content-';

/** KaTeX output by `display` + source; typing re-renders the whole note, most formulas are unchanged. */
const katexCache = new Map<string, string>();
const KATEX_CACHE_MAX = 2000;

function katexHtml(tex: string, displayMode: boolean): string {
  const key = (displayMode ? 'D' : 'I') + tex;
  let html = katexCache.get(key);
  if (html === undefined) {
    try {
      // trust: false — no \href, \url, \includegraphics, \htmlClass/\htmlId/\htmlStyle/\htmlData.
      html = katex.renderToString(tex, { displayMode, throwOnError: false, strict: 'ignore', trust: false, maxExpand: 1000, maxSize: 50 });
    } catch {
      html = `<span class="katex-error">${escapeHtml(tex)}</span>`;
    }
    if (katexCache.size >= KATEX_CACHE_MAX) katexCache.clear();
    katexCache.set(key, html);
  }
  return html;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function textOf(node: Element): string {
  let out = '';
  for (const c of node.children) out += c.type === 'text' ? c.value : c.type === 'element' ? textOf(c) : '';
  return out;
}

/**
 * After sanitizing (trusted code only from here on):
 * - links: only http(s)/mailto and in-page `#…` hrefs remain (relative URLs from raw HTML would reach app
 *   routes); external links open in a new tab without referrer; in-page targets get the id prefix.
 * - images: vault files (`/api/file`) or external http(s) (no referrer, lazy); anything else is dropped.
 * - math (`code.math-*` that survived the sanitizer) → KaTeX markup as `raw`. The sanitizer removed every
 *   other `raw` node, so KaTeX output is the only raw HTML that reaches the string.
 */
function rehypeHardenAndMath() {
  return (tree: HastRoot) => {
    walkElements(tree, (el, parent, index) => {
      if (el.tagName === 'a') {
        const href = el.properties.href;
        if (typeof href !== 'string') return;
        if (EXTERNAL_RE.test(href)) {
          el.properties.rel = ['noopener', 'noreferrer', 'nofollow'];
          el.properties.target = '_blank';
        } else if (href.startsWith('#')) {
          if (href.length > 1 && !href.startsWith('#' + CLOBBER)) el.properties.href = '#' + CLOBBER + href.slice(1);
        } else delete el.properties.href;
        return;
      }
      if (el.tagName === 'input') {
        if (el.properties.dataLine === undefined) el.properties.disabled = true;
        return;
      }
      if (el.tagName === 'img') {
        const src = typeof el.properties.src === 'string' ? el.properties.src : '';
        if (/^https?:/i.test(src)) {
          el.properties.referrerPolicy = 'no-referrer';
          el.properties.loading = 'lazy';
        } else if (!src.startsWith(VAULT_FILE_PREFIX)) {
          parent.children.splice(index, 1);
          return index;
        }
        return;
      }
      const only = el.children.length === 1 ? el.children[0] : undefined;
      const code = el.tagName === 'pre' && only?.type === 'element' ? only : el;
      if (code.tagName !== 'code') return;
      const cls = classes(code);
      if (!cls.includes('math-inline') && !cls.includes('math-display') && !cls.includes('language-math')) return;
      const display = el !== code || cls.includes('math-display');
      parent.children.splice(index, 1, { type: 'raw', value: katexHtml(textOf(code), display) });
      return index + 1;
    });
  };
}

/**
 * GFM without the autolink-literal extension: that one costs about a third of the parse time on long notes.
 * Bare URLs are linked by remark-obsidian's text pass instead.
 */
function remarkGfmLite(this: Processor) {
  const data = this.data();
  (data.micromarkExtensions ??= []).push(gfmFootnote(), gfmStrikethrough(), gfmTable(), gfmTaskListItem());
  (data.fromMarkdownExtensions ??= []).push(
    gfmFootnoteFromMarkdown(),
    gfmStrikethroughFromMarkdown(),
    gfmTableFromMarkdown(),
    gfmTaskListItemFromMarkdown(),
  );
}

const processor = unified()
  .use(remarkParse)
  .use(remarkGfmLite)
  .use(remarkMath)
  .use(remarkObsidian)
  // clobberPrefix '' : the sanitizer adds `user-content-` to every id (footnotes included) exactly once.
  .use(remarkRehype, { allowDangerousHtml: true, clobberPrefix: '', footnoteLabel: 'Fußnoten', footnoteBackLabel: 'Zurück zum Text' })
  .use(rehypeTasksAndRaw)
  .use(rehypeSanitize, schema)
  .use(rehypeHardenAndMath)
  .use(rehypeStringify, { allowDangerousHtml: true })
  .freeze();

/** Note text → sanitized HTML (conventions: see `docs`/task brief; frontmatter and `%%comments%%` omitted). */
export function renderMarkdown(text: string, ctx: RenderContext): string {
  const file = new VFile({ value: prepareSource(text), data: { obsidian: { ...ctx, depth: ctx.depth ?? 0 } } });
  const tree = processor.runSync(processor.parse(file), file);
  return processor.stringify(tree, file);
}

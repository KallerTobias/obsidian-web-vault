import GithubSlugger, { slug } from 'github-slugger';
import type {
  Blockquote,
  Definition,
  Image,
  Link,
  Nodes,
  Paragraph,
  Parent,
  PhrasingContent,
  Root,
  RootContent,
  Text,
} from 'mdast';
import { toString } from 'mdast-util-to-string';
import { visit } from 'unist-util-visit';
import type { VFile } from 'vfile';
import { findFrontmatter } from '@shared/parse';
import { basename, dirname, relativeTo } from '@shared/normalize';
import { resolveLink, type FileLookup } from '@shared/resolve';
import { mediaKind } from '../media';

/*
 * Obsidian syntax on top of remark (mdast): wikilinks, embeds, tags, ==highlights==, callouts, block IDs,
 * heading ids, Mermaid sources, `$$…$$` on one line as display math, and vault-aware Markdown links/images.
 * `%%comments%%` and the frontmatter are removed from the source beforehand (`prepareSource`), keeping the
 * line count so positions stay the note's real line numbers (task checkboxes rely on that).
 */

export interface RenderContext {
  /** Vault path of the note being rendered (links resolve relative to it). */
  path: string;
  lookup: FileLookup;
  /** 0 for the note itself, n for content embedded n levels deep. */
  depth?: number;
}

declare module 'vfile' {
  interface DataMap {
    obsidian: RenderContext;
  }
}

/** URL of a vault file for `<img src>` (same as `api.file.url`, without pulling the API client in). */
export const fileUrl = (path: string) => `/api/file?path=${encodeURIComponent(path)}`;

/** Element id a `#subpath` (heading or `^block`; nested `A#B` → last part) points to in the rendered HTML. */
export function subpathId(subpath: string): string {
  const part = subpath.split('#').filter((p) => p.trim() !== '').pop()?.trim() ?? '';
  return 'user-content-' + (part.startsWith('^') ? part : slug(part));
}

// --- source preparation -------------------------------------------------------------------------

const FENCE_OPEN_RE = /^[ \t>]*(`{3,}|~{3,})/;
const FENCE_CLOSE_RE = /^[ \t>]*(`{3,}|~{3,})[ \t]*$/;

/** Removes `%%…%%` outside code (fenced blocks and inline code spans); newlines inside comments are kept. */
function stripComments(src: string): string {
  const out: string[] = [];
  let fence: { ch: string; len: number } | null = null;
  let inComment = false;
  for (const line of src.split('\n')) {
    if (!inComment) {
      if (fence) {
        const m = FENCE_CLOSE_RE.exec(line);
        if (m && m[1]![0] === fence.ch && m[1]!.length >= fence.len) fence = null;
        out.push(line);
        continue;
      }
      const m = FENCE_OPEN_RE.exec(line);
      if (m) {
        fence = { ch: m[1]![0]!, len: m[1]!.length };
        out.push(line);
        continue;
      }
    }
    if (!inComment && !line.includes('%%')) {
      out.push(line);
      continue;
    }
    let res = '';
    let i = 0;
    const n = line.length;
    while (i < n) {
      if (inComment) {
        const e = line.indexOf('%%', i);
        if (e < 0) break;
        inComment = false;
        i = e + 2;
        continue;
      }
      const c = line[i]!;
      if (c === '\\') {
        res += line.slice(i, i + 2);
        i += 2;
      } else if (c === '`') {
        let j = i;
        while (line[j] === '`') j++;
        const run = line.slice(i, j);
        let close = -1;
        for (let k = line.indexOf(run, j); k >= 0; k = line.indexOf(run, k + 1)) {
          if (line[k + run.length] !== '`' && line[k - 1] !== '`') {
            close = k + run.length;
            break;
          }
        }
        const end = close < 0 ? j : close;
        res += line.slice(i, end);
        i = end;
      } else if (c === '%' && line[i + 1] === '%') {
        inComment = true;
        i += 2;
      } else {
        res += c;
        i++;
      }
    }
    out.push(res);
  }
  return out.join('\n');
}

/** Drops BOM, frontmatter (replaced by its newlines) and comments, so line numbers stay those of `text`. */
export function prepareSource(text: string): string {
  let src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const fm = findFrontmatter(src, 0);
  if (fm) src = src.slice(0, fm.to).replace(/[^\n]/g, '') + src.slice(fm.to);
  return src.includes('%%') ? stripComments(src) : src;
}

// --- helpers ------------------------------------------------------------------------------------

const text = (value: string): Text => ({ type: 'text', value });

function setProps(node: Nodes, props: Record<string, unknown>): void {
  const data = (node.data ??= {});
  data.hProperties = { ...data.hProperties, ...(props as NonNullable<typeof data.hProperties>) };
}

function decode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function internalLink(resolved: string | null, target: string, subpath: string | undefined, children: PhrasingContent[]): Link {
  return {
    type: 'link',
    url: '#',
    children,
    data: {
      hProperties: {
        className: resolved === null ? ['internal-link', 'is-unresolved'] : ['internal-link'],
        dataHref: resolved ?? target,
        dataSubpath: subpath,
      },
    },
  };
}

const SIZE_RE = /^(\d+)(?:x(\d+))?$/;

function sizeProps(size: string | undefined): Record<string, string> {
  const m = size === undefined ? null : SIZE_RE.exec(size.trim());
  if (!m) return {};
  return m[2] === undefined ? { width: m[1]! } : { width: m[1]!, height: m[2] };
}

// --- the plugin ---------------------------------------------------------------------------------

/** `[[…]]` / `![[…]]`, or `#tag` after whitespace or at the start of a text node. */
const INLINE_RE = /(!?)\[\[([^[\]\n]+?)\]\]|(?<=^|\s)#([\p{L}\p{N}_/-]+)|(?<=^|[\s(])(?:https?:\/\/|www\.)[^\s<>]+/giu;
/** Not part of a bare URL at its end (GFM autolink literal rules, simplified). */
const URL_TRAIL_RE = /[.,:;!?*_~'"]+$/;
const DIGITS_RE = /^\p{N}+$/u;
const CALLOUT_RE = /^\[!([^\]\s]+)\]([+-]?)[ \t]*/;
const BLOCK_ID_RE = /(^|\s)\^([A-Za-z0-9-]+)\s*$/;
const SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;
const EXTERNAL_RE = /^(?:https?:|mailto:)/i;
const PHRASING_PARENTS = new Set(['paragraph', 'heading', 'emphasis', 'strong', 'delete', 'link', 'tableCell']);

export default function remarkObsidian() {
  return (tree: Root, file: VFile) => {
    const ctx = file.data.obsidian!;
    const source = String(file.value);
    const embeds = new WeakSet<Nodes>();
    const slugger = new GithubSlugger();

    // Reference-style links/images become plain ones, so the vault-aware handling covers them too.
    const defs = new Map<string, Definition>();
    if (source.includes(']:')) {
      visit(tree, 'definition', (d) => {
        if (!defs.has(d.identifier)) defs.set(d.identifier, d);
      });
    }

    const resolve = (target: string) => (target === '' ? ctx.path : resolveLink(target, ctx.path, ctx.lookup));

    const embedNode = (resolved: string | null, target: string, subpath: string | undefined, alias: string | undefined): PhrasingContent => {
      if (resolved === null) return internalLink(null, target, subpath, [text(target)]);
      if (mediaKind(resolved) === 'image') {
        const size = sizeProps(alias);
        const img: Image = { type: 'image', url: fileUrl(resolved), alt: Object.keys(size).length || !alias ? basename(resolved) : alias };
        setProps(img, size);
        return img;
      }
      const node: PhrasingContent = {
        type: 'emphasis',
        children: [],
        data: { hName: 'span', hProperties: { className: ['embed'], dataEmbed: resolved, dataSubpath: subpath } },
      };
      embeds.add(node);
      return node;
    };

    /** Wikilinks, embeds and tags inside one text node; null when there are none. */
    const inline = (node: Text): PhrasingContent[] | null => {
      const v = node.value;
      if (!v.includes('[[') && !v.includes('#') && !v.includes('://') && !/www\./i.test(v)) return null;
      const out: PhrasingContent[] = [];
      let last = 0;
      INLINE_RE.lastIndex = 0;
      for (let m: RegExpExecArray | null; (m = INLINE_RE.exec(v)); ) {
        let replacement: PhrasingContent | null = null;
        if (m[2] !== undefined) {
          const inner = m[2];
          const pipe = inner.indexOf('|');
          const linkPart = pipe < 0 ? inner : inner.slice(0, pipe);
          const alias = pipe < 0 ? undefined : inner.slice(pipe + 1).trim() || undefined;
          const hash = linkPart.indexOf('#');
          const target = (hash < 0 ? linkPart : linkPart.slice(0, hash)).trim();
          const subpath = hash < 0 ? undefined : linkPart.slice(hash + 1).trim() || undefined;
          if (target !== '' || subpath !== undefined) {
            const resolved = resolve(target);
            if (m[1]) replacement = embedNode(resolved, target, subpath, alias);
            else {
              const shownSub = subpath?.replace(/#/g, ' > ');
              const label = alias ?? (target === '' ? shownSub! : shownSub ? `${target} > ${shownSub}` : target);
              replacement = internalLink(resolved, target, subpath, [text(label)]);
            }
          }
        } else if (m[3] !== undefined) {
          if (!DIGITS_RE.test(m[3])) {
            replacement = { type: 'link', url: '#', children: [text('#' + m[3])], data: { hProperties: { className: ['tag'], dataTag: m[3] } } };
          }
        } else {
          let url = m[0].replace(URL_TRAIL_RE, '');
          // A closing parenthesis belongs to the URL only if it is balanced inside it.
          while (url.endsWith(')') && url.split(')').length > url.split('(').length) url = url.slice(0, -1).replace(URL_TRAIL_RE, '');
          if (/^(?:https?:\/\/|www\.)./i.test(url)) {
            const href = /^www\./i.test(url) ? 'http://' + url : url;
            replacement = { type: 'link', url: href, children: [text(url)] };
            m[0] = url; // the rest stays text
          }
        }
        if (!replacement) continue;
        if (m.index > last) out.push(text(v.slice(last, m.index)));
        out.push(replacement);
        last = m.index + m[0].length;
        INLINE_RE.lastIndex = last;
      }
      if (out.length === 0) return null;
      if (last < v.length) out.push(text(v.slice(last)));
      return out;
    };

    /** Markdown link: external stays; vault paths become internal links; other schemes lose the link. */
    const markdownLink = (node: Link): PhrasingContent[] | Link | null => {
      const url = node.url.trim();
      if (EXTERNAL_RE.test(url)) return null;
      if (SCHEME_RE.test(url) || url.startsWith('//') || url === '') return node.children;
      const hash = url.indexOf('#');
      const target = decode(hash < 0 ? url : url.slice(0, hash));
      const subpath = hash < 0 ? undefined : decode(url.slice(hash + 1)) || undefined;
      // Unresolved: Markdown links are relative to the note's folder (`/…` from the vault root), so the
      // note a click creates lands where the link expects it.
      return internalLink(resolve(target), relativeTo(dirname(ctx.path), target), subpath, node.children);
    };

    /** Markdown image: external stays, vault paths point to `/api/file`; false = drop it. */
    const markdownImage = (node: Image): boolean => {
      const url = node.url.trim();
      const sized = /^(.*?)\|(\d+(?:x\d+)?)$/.exec(node.alt ?? '');
      if (sized) {
        node.alt = sized[1]!;
        setProps(node, sizeProps(sized[2]));
      }
      if (/^https?:/i.test(url)) return true;
      if (SCHEME_RE.test(url) || url.startsWith('//')) return false;
      const resolved = resolveLink(decode(url.split('#')[0]!), ctx.path, ctx.lookup);
      if (resolved === null) return false;
      node.url = fileUrl(resolved);
      return true;
    };

    /** One hand-written pass (several `visit`s cost more than the parse itself on long notes). */
    const walk = (parent: Parent, inLink: boolean): void => {
      const kids = parent.children as RootContent[];
      for (let i = 0; i < kids.length; i++) {
        let child = kids[i]!;
        if (child.type === 'linkReference' || child.type === 'imageReference') {
          const def = defs.get(child.identifier);
          if (def) {
            child = kids[i] =
              child.type === 'linkReference'
                ? { type: 'link', url: def.url, title: def.title, children: child.children }
                : { type: 'image', url: def.url, title: def.title, alt: child.alt };
          }
        }
        switch (child.type) {
          case 'text': {
            if (inLink) continue;
            const out = inline(child);
            if (out) {
              kids.splice(i, 1, ...(out as RootContent[]));
              i += out.length - 1;
            }
            continue;
          }
          case 'heading':
            // From the heading text as written, like Obsidian's `[[Note#Heading]]`.
            setProps(child, { id: slugger.slug(toString(child)) });
            break;
          case 'code':
            // Mermaid stays text, rendered in the browser.
            if (child.lang?.toLowerCase() === 'mermaid') {
              kids[i] = {
                type: 'paragraph',
                children: [],
                data: { hName: 'pre', hProperties: { className: ['mermaid-src'] }, hChildren: [{ type: 'text', value: child.value + '\n' }] },
              };
            }
            continue;
          case 'inlineMath':
            // `$$x$$` inside a line is display math in Obsidian.
            if (source.startsWith('$$', child.position?.start.offset ?? -1)) setProps(child, { className: ['language-math', 'math-display'] });
            continue;
          case 'link': {
            if (inLink) break;
            const r = markdownLink(child);
            if (Array.isArray(r)) {
              kids.splice(i, 1, ...(r as RootContent[]));
              i--; // look at the unwrapped children again
              continue;
            }
            if (r) {
              kids[i] = r;
              walk(r, true);
              continue;
            }
            walk(child, true);
            continue;
          }
          case 'image':
            if (!markdownImage(child)) {
              kids.splice(i, 1);
              i--;
            }
            continue;
        }
        if ('children' in child) walk(child, inLink);
        if (child.type === 'blockquote') callout(child);
        else if (child.type === 'paragraph') {
          // Block IDs: `text ^id` marks its paragraph (or list item); `^id` alone marks the block before it.
          const last = child.children[child.children.length - 1];
          const m = last?.type === 'text' && last.value.includes('^') ? BLOCK_ID_RE.exec(last.value) : null;
          if (m && last?.type === 'text') {
            const id = '^' + m[2]!;
            const head = last.value.slice(0, m.index);
            if (head.trim() === '' && child.children.length === 1) {
              const prev = kids[i - 1];
              if (prev) {
                setProps(prev, { id });
                kids.splice(i, 1);
                i--;
                continue;
              }
            } else {
              last.value = head.replace(/[ \t]+$/, '');
              setProps(parent.type === 'listItem' ? (parent as Nodes) : child, { id });
            }
          }
          // A paragraph holding only embeds becomes block-level embeds (`div`).
          const blocks = child.children.filter((c) => !(c.type === 'text' && c.value.trim() === '') && c.type !== 'break');
          if (blocks.length > 0 && blocks.every((c) => embeds.has(c))) {
            for (const b of blocks) b.data!.hName = 'div';
            kids.splice(i, 1, ...(blocks as RootContent[]));
            i += blocks.length - 1;
          }
        }
      }
      if (PHRASING_PARENTS.has(parent.type)) highlight(parent);
    };
    walk(tree, false);
  };
}

/** Wraps `==…==` ranges among `parent`'s children into `<mark>` (an emphasis node rendered as `mark`). */
function highlight(parent: Parent): void {
  const kids = parent.children as PhrasingContent[];
  for (let i = 0; i < kids.length; i++) {
    const open = kids[i]!;
    if (open.type !== 'text') continue;
    let from = 0;
    for (;;) {
      const p = open.value.indexOf('==', from);
      if (p < 0) break;
      from = p + 2;
      const after = open.value[p + 2];
      if (after === ' ' || after === '\t' || after === '\n' || after === '=') continue;
      if (after === undefined && i === kids.length - 1) break;
      // Find the closing `==` in this or a later text sibling.
      let close: { j: number; q: number } | null = null;
      for (let j = i; j < kids.length && !close; j++) {
        const k = kids[j]!;
        if (k.type !== 'text') continue;
        for (let q = k.value.indexOf('==', j === i ? p + 3 : 0); q >= 0; q = k.value.indexOf('==', q + 1)) {
          const before = q > 0 ? k.value[q - 1] : undefined;
          if (before === ' ' || before === '\t' || before === '\n') continue;
          if (before === undefined && j === i) continue;
          close = { j, q };
          break;
        }
      }
      if (!close) return;
      const closeNode = kids[close.j] as Text;
      let inner: PhrasingContent[];
      let rest: string;
      if (close.j === i) {
        inner = [text(open.value.slice(p + 2, close.q))];
        rest = open.value.slice(close.q + 2);
      } else {
        inner = [
          ...(p + 2 < open.value.length ? [text(open.value.slice(p + 2))] : []),
          ...kids.slice(i + 1, close.j),
          ...(close.q > 0 ? [text(closeNode.value.slice(0, close.q))] : []),
        ];
        rest = closeNode.value.slice(close.q + 2);
      }
      const mark: PhrasingContent = { type: 'emphasis', children: inner, data: { hName: 'mark' } };
      const repl: PhrasingContent[] = [...(p > 0 ? [text(open.value.slice(0, p))] : []), mark, ...(rest ? [text(rest)] : [])];
      kids.splice(i, close.j - i + 1, ...repl);
      i += p > 0 ? 1 : 0; // now at the mark; the loop moves on to the rest
      break;
    }
  }
}

/** `> [!type]± Title` → `div.callout[data-callout][data-fold]` with `.callout-title` and `.callout-content`. */
function callout(bq: Blockquote): void {
  const para = bq.children[0];
  if (!para || para.type !== 'paragraph') return;
  const first = para.children[0];
  if (!first || first.type !== 'text') return;
  const m = CALLOUT_RE.exec(first.value);
  if (!m) return;
  const type = m[1]!.toLowerCase();
  first.value = first.value.slice(m[0].length);
  const title: PhrasingContent[] = [];
  const body: PhrasingContent[] = [];
  let inBody = false;
  for (const child of para.children) {
    if (inBody) body.push(child);
    else if (child.type === 'break') inBody = true;
    else if (child.type === 'text' && child.value.includes('\n')) {
      const nl = child.value.indexOf('\n');
      if (nl > 0) title.push(text(child.value.slice(0, nl)));
      if (nl + 1 < child.value.length) body.push(text(child.value.slice(nl + 1)));
      inBody = true;
    } else title.push(child);
  }
  const shown = title.filter((c) => !(c.type === 'text' && c.value.trim() === ''));
  const titleNode: Paragraph = {
    type: 'paragraph',
    children: shown.length > 0 ? title : [text(type.charAt(0).toUpperCase() + type.slice(1))],
    data: { hName: 'div', hProperties: { className: ['callout-title'] } },
  };
  const content: Blockquote = {
    type: 'blockquote',
    children: [...(body.length > 0 ? [{ type: 'paragraph', children: body } as Paragraph] : []), ...bq.children.slice(1)],
    data: { hName: 'div', hProperties: { className: ['callout-content'] } },
  };
  bq.children = [titleNode, content];
  bq.data = { hName: 'div', hProperties: { className: ['callout'], dataCallout: type, dataFold: m[2]! } };
}

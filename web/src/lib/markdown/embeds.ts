import { parseNote } from '@shared/parse';
import { basename } from '@shared/normalize';
import type { FileLookup } from '@shared/resolve';
import { t } from '../i18n';
import { mediaKind } from '../media';
import { fileUrl } from './remark-obsidian';
import { renderMarkdown } from './render';

/*
 * Embeds in rendered notes: `renderMarkdown` leaves `.embed[data-embed][data-subpath]` placeholders; the
 * reading view fills them here — notes (or one of their sections) rendered one level deeper, PDFs,
 * audio and video. Note embeds nest up to `MAX_EMBED_DEPTH`; an embed of a note (section) that is
 * already being shown further up the chain is a cycle and is not expanded.
 */

export const MAX_EMBED_DEPTH = 3;
/** Embeds filled per view in total (all levels); a note with hundreds of embeds must not flood the server. */
export const MAX_EMBEDS = 200;

export interface EmbedContext {
  lookup: FileLookup;
  /** Depth of the content the placeholders are in (0 = the note itself). */
  depth: number;
  /** `path#subpath` keys of the note (sections) shown above, the outermost first. */
  chain: string[];
  /** Note text by vault path. */
  load: (path: string) => Promise<string>;
  /** Embeds still allowed in this view, shared by all levels; default: a fresh `MAX_EMBEDS`. */
  budget?: { left: number };
  /** Re-renders Mermaid sources in filled embeds; optional. */
  afterRender?: (el: HTMLElement) => void;
}

const LIST_ITEM_RE = /^\s*(?:[-*+]|\d+[.)])\s/;

export const embedKey =(path: string, subpath?: string) => (subpath ? `${path}#${subpath}` : path);

/**
 * The part of a note an embed `![[Note#subpath]]` shows: `#Heading` (also nested `#A#B`, the last part
 * counts) → the heading and everything below it up to the next heading of the same or a higher level;
 * `#^id` → the block carrying the ID (its list item, or its paragraph; a standalone `^id` line marks the
 * block before it). Without a subpath: the whole text. Null when the target is not in the note.
 */
export function extractSection(text: string, subpath: string | undefined): string | null {
  if (!subpath) return text;
  const lines = text.split('\n');
  const part = subpath.split('#').filter((p) => p.trim() !== '').pop()?.trim();
  if (!part) return text;

  if (part.startsWith('^')) {
    const id = part.slice(1);
    if (!/^[A-Za-z0-9-]+$/.test(id)) return null;
    const marker = new RegExp(`(^|\\s)\\^${id}\\s*$`);
    const at = lines.findIndex((l) => marker.test(l));
    if (at < 0) return null;
    const blank = (i: number) => lines[i]!.trim() === '';
    let start: number;
    let end: number;
    if (lines[at]!.trim() === '^' + id) {
      // Standalone ID: the whole block above it.
      end = at - 1;
      while (end >= 0 && blank(end)) end--;
      if (end < 0) return null;
      start = end;
    } else if (LIST_ITEM_RE.test(lines[at]!)) {
      // In a list the ID marks just its item.
      return lines[at]!.replace(marker, '').trimEnd();
    } else {
      start = end = at;
      while (end + 1 < lines.length && !blank(end + 1)) end++;
    }
    while (start > 0 && !blank(start - 1)) start--;
    return lines
      .slice(start, end + 1)
      .map((l) => l.replace(marker, ''))
      .join('\n')
      .trimEnd();
  }

  const want = part.toLowerCase();
  const headings = parseNote(text).headings;
  const i = headings.findIndex((h) => h.text.toLowerCase() === want);
  if (i < 0) return null;
  const h = headings[i]!;
  const next = headings.slice(i + 1).find((n) => n.level <= h.level);
  return lines.slice(h.line, next ? next.line : lines.length).join('\n').trimEnd();
}

function notice(el: HTMLElement, message: string): void {
  el.replaceChildren();
  const p = document.createElement('p');
  p.className = 'embed-notice';
  p.textContent = message;
  el.append(p);
}

function mediaEmbed(el: HTMLElement, path: string, subpath: string | undefined): boolean {
  const kind = mediaKind(path);
  const src = fileUrl(path);
  const name = basename(path);
  let media: HTMLElement;
  if (kind === 'pdf') {
    const frame = document.createElement('iframe');
    // `#page=3` jumps to that page in the browser's PDF viewer.
    frame.src = subpath && /^page=\d+$/.test(subpath) ? `${src}#${subpath}` : src;
    frame.title = name;
    media = frame;
  } else if (kind === 'audio' || kind === 'video') {
    const m = document.createElement(kind);
    m.src = src;
    m.controls = true;
    m.preload = 'metadata';
    m.setAttribute('aria-label', name);
    media = m;
  } else if (kind === 'other') {
    const a = document.createElement('a');
    a.href = src;
    a.download = name;
    a.textContent = name;
    media = a;
  } else return false;
  el.classList.add('embed-' + kind);
  el.replaceChildren(media);
  return true;
}

/** Fills the placeholders in `root`; the embedded notes' own embeds are filled recursively. */
export async function hydrateEmbeds(root: HTMLElement, ctx: EmbedContext): Promise<void> {
  const placeholders = [...root.querySelectorAll<HTMLElement>('.embed[data-embed]')].filter((el) => !el.dataset.embedState);
  const withBudget = ctx.budget ? ctx : { ...ctx, budget: { left: MAX_EMBEDS } };
  await Promise.all(placeholders.map((el) => hydrateOne(el, withBudget)));
}

async function hydrateOne(el: HTMLElement, ctx: EmbedContext): Promise<void> {
  const path = el.dataset.embed!;
  const subpath = el.dataset.subpath || undefined;
  if (ctx.budget!.left <= 0) {
    notice(el, t.embeds.tooMany);
    el.dataset.embedState = 'over-budget';
    return;
  }
  ctx.budget!.left--;
  el.dataset.embedState = 'loading';
  if (!path.toLowerCase().endsWith('.md')) {
    if (!mediaEmbed(el, path, subpath)) notice(el, t.media.unsupported);
    el.dataset.embedState = 'done';
    return;
  }
  const key = embedKey(path, subpath);
  if (ctx.chain.includes(key)) {
    notice(el, t.embeds.cycle);
    el.dataset.embedState = 'cycle';
    return;
  }
  if (ctx.depth + 1 > MAX_EMBED_DEPTH) {
    notice(el, t.embeds.tooDeep);
    el.dataset.embedState = 'too-deep';
    return;
  }
  let text: string;
  try {
    text = await ctx.load(path);
  } catch {
    notice(el, t.embeds.loadFailed);
    el.dataset.embedState = 'failed';
    return;
  }
  const section = extractSection(text, subpath);
  if (section === null) {
    notice(el, t.embeds.sectionMissing(subpath!));
    el.dataset.embedState = 'missing';
    return;
  }
  const depth = ctx.depth + 1;
  const body = document.createElement('div');
  body.className = 'embed-content markdown';
  body.innerHTML = renderMarkdown(section, { path, lookup: ctx.lookup, depth });
  const title = document.createElement('a');
  title.className = 'embed-link internal-link';
  title.dataset.href = path;
  if (subpath) title.dataset.subpath = subpath;
  title.textContent = basename(path).replace(/\.md$/i, '') + (subpath ? ' > ' + subpath.replace(/#/g, ' > ') : '');
  el.classList.add('embed-note');
  el.replaceChildren(title, body);
  el.dataset.embedState = 'done';
  ctx.afterRender?.(body);
  await hydrateEmbeds(body, { ...ctx, depth, chain: [...ctx.chain, key] });
}

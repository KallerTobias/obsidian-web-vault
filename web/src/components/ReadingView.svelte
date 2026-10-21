<script lang="ts" module>
  export interface OpenLinkOptions {
    subpath?: string;
    newTab: boolean;
    /** The target does not exist yet (`data-href` is then the link text, not a path). */
    unresolved: boolean;
  }
</script>

<script lang="ts">
  import type { FileLookup } from '@shared/resolve';
  import { api } from '../lib/api';
  import { embedKey, hydrateEmbeds, MAX_EMBEDS } from '../lib/markdown/embeds';
  import { renderMermaid } from '../lib/markdown/mermaid';
  import { renderMarkdown, subpathId } from '../lib/markdown/render';

  /** A note rendered as HTML (reading mode), with embeds, diagrams and clickable links, tags and tasks. */
  let {
    path,
    content,
    lookup,
    subpath,
    loadNote = async (p: string) => (await api.note.get(p)).content,
    onOpenLink,
    onTag,
    onToggleTask,
  }: {
    path: string;
    content: string;
    lookup: FileLookup;
    /** Heading or block to scroll to. */
    subpath?: string;
    loadNote?: (path: string) => Promise<string>;
    onOpenLink?: (target: string, opts: OpenLinkOptions) => void;
    onTag?: (tag: string) => void;
    /** A task checkbox was clicked; `line` is its 0-based line in `content`. */
    onToggleTask?: (line: number) => void;
  } = $props();

  let container: HTMLElement;
  const html = $derived(renderMarkdown(content, { path, lookup }));

  /** Folded callouts (`[!x]-`) start collapsed; their title toggles them. */
  function initCallouts(root: HTMLElement): void {
    for (const c of root.querySelectorAll<HTMLElement>('.callout[data-fold="-"], .callout[data-fold="+"]')) {
      if (c.dataset.foldInit) continue;
      c.dataset.foldInit = '1';
      c.classList.toggle('is-collapsed', c.dataset.fold === '-');
      const title = c.querySelector<HTMLElement>(':scope > .callout-title');
      if (!title) continue;
      title.setAttribute('role', 'button');
      title.tabIndex = 0;
      title.setAttribute('aria-expanded', String(c.dataset.fold !== '-'));
    }
  }

  function afterRender(root: HTMLElement): void {
    initCallouts(root);
    void renderMermaid(root).catch(() => {
      /* diagram library failed to load: the source stays visible */
    });
  }

  /**
   * `path#subpath` of the last navigation that was scrolled to. Re-renders (edits, task toggles, a new
   * lookup after any vault change) must not yank the reader back, so only a new target scrolls — once
   * right away and once more when the embeds of that render have loaded (they shift the content).
   */
  let scrolledTo: string | null = null;
  let rescrollAfterEmbeds: string | null = null;
  const navKey = () => `${path}#${subpath ?? ''}`;

  $effect(() => {
    void html; // re-run after every render
    const root = container;
    afterRender(root);
    // Every render starts a fresh load cache: the embedded notes may have changed too.
    const cache = new Map<string, Promise<string>>();
    const load = (p: string) => {
      let text = cache.get(p);
      if (!text) cache.set(p, (text = loadNote(p)));
      return text;
    };
    void hydrateEmbeds(root, { lookup, depth: 0, chain: [embedKey(path)], load, afterRender, budget: { left: MAX_EMBEDS } }).then(() => {
      if (!subpath || rescrollAfterEmbeds !== navKey()) return;
      rescrollAfterEmbeds = null;
      if (root.querySelector('.embed[data-embed-state]')) scrollToSubpath(subpath);
    });
  });

  /** Scrolls to a heading (`Kopf`, `A#B`) or block (`^id`) of this note; false if it is not there. */
  export function scrollToSubpath(sub: string): boolean {
    const id = subpathId(sub);
    // Looked up inside this view: another open tab may show a note with the same heading.
    const el = [...container.querySelectorAll<HTMLElement>('[id]')].find((e) => e.id === id);
    el?.scrollIntoView({ block: 'start' });
    return el !== undefined;
  }

  $effect(() => {
    // Depends on path and subpath only (not on the rendered HTML).
    const key = navKey();
    if (!subpath || key === scrolledTo) return;
    scrolledTo = rescrollAfterEmbeds = key;
    scrollToSubpath(subpath);
  });

  function toggleCallout(title: HTMLElement): void {
    const c = title.parentElement!;
    const collapsed = c.classList.toggle('is-collapsed');
    title.setAttribute('aria-expanded', String(!collapsed));
  }

  function onclick(e: MouseEvent): void {
    const target = e.target as HTMLElement;
    const box = target.closest<HTMLInputElement>('input[type="checkbox"][data-line]');
    if (box) {
      e.preventDefault();
      // Embedded notes are rendered read-only; their line numbers are not this note's.
      if (box.closest('.embed-content')) return;
      // The note on disk decides: the box shows the new state once the saved text is rendered again.
      onToggleTask?.(Number(box.dataset.line));
      return;
    }
    const title = target.closest<HTMLElement>('.callout[data-fold="-"] > .callout-title, .callout[data-fold="+"] > .callout-title');
    if (title && !target.closest('a')) {
      toggleCallout(title);
      return;
    }
    const link = target.closest<HTMLAnchorElement>('a.internal-link, a.tag');
    if (!link) return;
    e.preventDefault();
    if (link.classList.contains('tag')) {
      if (link.dataset.tag) onTag?.(link.dataset.tag);
    } else if (link.dataset.href)
      onOpenLink?.(link.dataset.href, {
        subpath: link.dataset.subpath,
        newTab: e.ctrlKey || e.metaKey || e.button === 1,
        unresolved: link.classList.contains('is-unresolved'),
      });
  }

  function onauxclick(e: MouseEvent): void {
    if (e.button === 1 && (e.target as HTMLElement).closest('a.internal-link')) onclick(e);
  }

  function onkeydown(e: KeyboardEvent): void {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const title = (e.target as HTMLElement).closest<HTMLElement>('.callout > .callout-title[role="button"]');
    if (!title) return;
    e.preventDefault();
    toggleCallout(title);
  }
</script>

<!-- Clicks are delegated: links, tags, tasks and callout titles inside the rendered HTML are keyboard-reachable themselves. -->
<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div class="markdown reading-view" bind:this={container} {onclick} {onauxclick} {onkeydown}>
  <!-- Sanitized by renderMarkdown. -->
  {@html html}
</div>

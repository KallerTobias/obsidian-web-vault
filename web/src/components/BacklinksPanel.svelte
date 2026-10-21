<script lang="ts">
  import { basename, stripMd } from '@shared/normalize';
  import { createFileLookup, linkTextFor } from '@shared/resolve';
  import { get } from 'svelte/store';
  import { api, ApiError, type Backlink } from '../lib/api';
  import { linkedSegments, linkMention, mentionPattern, mentionSegments, type Segment } from '../lib/backlinks';
  import { de } from '../lib/i18n/de';
  import { events } from '../lib/stores/events';
  import { editorSettings } from '../lib/stores/settings';
  import { vault } from '../lib/stores/vault';

  /**
   * Notes linking to `path` and notes mentioning it without a link. A click opens the source at the
   * context line; „Verlinken“ turns an unlinked mention into a link (written with `baseVersion`, never
   * over a newer file). Reloads (debounced) after vault changes.
   */
  let {
    path,
    aliases = [],
    onOpen,
  }: {
    path: string;
    aliases?: string[];
    onOpen: (source: string, line: number, newTab: boolean) => void;
  } = $props();

  const RELOAD_DELAY_MS = 500;

  let linked = $state<Backlink[]>([]);
  let unlinked = $state<Backlink[]>([]);
  let loadState = $state<'loading' | 'error' | 'ready'>('loading');
  let error = $state('');
  let busy = $state(false);
  let open = $state({ linked: true, unlinked: true });
  let generation = 0;

  const names = $derived([stripMd(basename(path)), ...aliases]);
  const mentionRe = $derived(mentionPattern(names));

  async function load(): Promise<void> {
    const g = ++generation;
    const p = path;
    try {
      const r = await api.backlinks(p);
      if (g !== generation) return;
      linked = r.linked;
      unlinked = r.unlinked;
      loadState = 'ready';
    } catch {
      if (g === generation) loadState = 'error';
    }
  }

  $effect(() => {
    void path;
    // The previous note's backlinks must not show (or be linked) under this one.
    linked = [];
    unlinked = [];
    loadState = 'loading';
    error = '';
    void load();
  });

  // Any change in the vault may add or remove a backlink.
  $effect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const off = events.onAnyChange(() => {
      clearTimeout(timer);
      timer = setTimeout(() => void load(), RELOAD_DELAY_MS);
    });
    return () => {
      off();
      clearTimeout(timer);
    };
  });

  function segments(kind: 'linked' | 'unlinked', text: string): Segment[] {
    if (kind === 'linked') return linkedSegments(text, path);
    return mentionRe ? mentionSegments(text, mentionRe) : [{ text, hit: false }];
  }

  async function linkIt(source: string, line: number, context: string): Promise<void> {
    error = '';
    busy = true;
    try {
      const note = await api.note.get(source);
      if (note.readonly) {
        error = de.backlinks.linkReadonly;
        return;
      }
      // The note itself may be missing from a lookup that is not reloaded yet (but must not count twice).
      const lookup = createFileLookup(new Set([...get(vault.lookup).map((e) => e.path), path]));
      const linkText = linkTextFor(path, source, lookup, get(editorSettings).newLinkFormat);
      const next = linkMention(note.content, line, names, linkText, context);
      if (next === null) {
        error = de.backlinks.mentionGone;
        return;
      }
      await api.note.save(source, next, note.version);
    } catch (e) {
      error = e instanceof ApiError && e.status === 409 ? de.backlinks.linkConflict : de.backlinks.linkFailed;
    } finally {
      busy = false;
      void load();
    }
  }
</script>

{#snippet section(kind: 'linked' | 'unlinked', list: Backlink[])}
  <div class="group">
    <button type="button" class="group-header" aria-expanded={open[kind]} onclick={() => (open[kind] = !open[kind])}>
      <span class="chevron" aria-hidden="true">{open[kind] ? '▾' : '▸'}</span>
      <span>{kind === 'linked' ? de.backlinks.linked : de.backlinks.unlinked}</span>
      <span class="count">{list.length}</span>
    </button>
    {#if open[kind]}
      {#if list.length === 0}
        <p class="empty">{de.backlinks.none}</p>
      {:else}
        <ul>
          {#each list as b (b.source)}
            <li class="source">
              <div class="source-name">{stripMd(basename(b.source))}</div>
              {#each b.contexts as c (c.line)}
                <div class="context">
                  <button
                    type="button"
                    class="context-text"
                    title={`${stripMd(b.source)} – ${de.backlinks.line(c.line + 1)}`}
                    onclick={(e) => onOpen(b.source, c.line, e.ctrlKey || e.metaKey)}
                  >
                    {#each segments(kind, c.text) as s, i (i)}{#if s.hit}<mark>{s.text}</mark>{:else}{s.text}{/if}{/each}
                  </button>
                  {#if kind === 'unlinked'}
                    <button type="button" class="link-button link-it" title={de.backlinks.linkTitle} disabled={busy} onclick={() => linkIt(b.source, c.line, c.text)}>
                      {de.backlinks.link}
                    </button>
                  {/if}
                </div>
              {/each}
            </li>
          {/each}
        </ul>
      {/if}
    {/if}
  </div>
{/snippet}

{#if loadState === 'loading' && linked.length === 0 && unlinked.length === 0}
  <p class="empty">{de.panel.loading}</p>
{:else if loadState === 'error'}
  <div class="empty" role="alert">
    <p>{de.backlinks.loadFailed}</p>
    <button type="button" class="link-button" onclick={load}>{de.retry}</button>
  </div>
{:else}
  {#if error}<p class="error" role="alert">{error}</p>{/if}
  {@render section('linked', linked)}
  {@render section('unlinked', unlinked)}
{/if}

<style>
  .empty,
  .error {
    margin: 0;
    font-size: var(--font-ui-small);
    color: var(--text-muted);
  }
  .error {
    padding: var(--size-2);
    border-radius: var(--radius-s, 4px);
    background: var(--background-modifier-error-soft);
    color: var(--text-normal);
  }
  .group + .group {
    margin-top: var(--size-2);
  }
  .group-header {
    display: flex;
    align-items: center;
    gap: var(--size-2);
    width: 100%;
    padding: 2px 0;
    border: 0;
    background: none;
    color: var(--text-muted);
    font: inherit;
    font-size: var(--font-ui-small);
    font-weight: 600;
    cursor: pointer;
  }
  .count {
    margin-left: auto;
    color: var(--text-faint);
    font-weight: normal;
  }
  ul {
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .source {
    padding: var(--size-2) 0;
  }
  .source-name {
    font-size: var(--font-ui-small);
    font-weight: 600;
    color: var(--text-normal);
  }
  .context {
    display: flex;
    align-items: flex-start;
    gap: var(--size-2);
  }
  .context-text {
    flex: 1;
    min-width: 0;
    padding: 2px var(--size-2);
    border: 0;
    border-radius: var(--radius-s, 4px);
    background: none;
    color: var(--text-muted);
    font: inherit;
    font-size: var(--font-ui-smaller);
    text-align: left;
    overflow-wrap: anywhere;
    cursor: pointer;
  }
  .context-text:hover {
    background: var(--background-modifier-hover);
  }
  mark {
    background: var(--text-highlight-bg, rgba(255, 208, 0, 0.4));
    color: inherit;
    border-radius: 2px;
  }
  .link-it {
    flex: none;
    font-size: var(--font-ui-smaller);
  }
</style>

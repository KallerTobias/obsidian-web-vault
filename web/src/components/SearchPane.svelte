<script lang="ts" module>
  export const SEARCH_DELAY_MS = 250;
  const LIMIT = 100;
</script>

<script lang="ts">
  import { basename, dirname } from '@shared/normalize';
  import { api, type SearchHit } from '../lib/api';
  import { segments } from '../lib/highlight';
  import { de } from '../lib/i18n/de';

  /**
   * Full-text search of the vault: the field takes the operators of the server (`path:` `tag:` `file:`,
   * "phrases", `-exclude`). Results are grouped by note with their matching lines; a click opens the note at
   * that line. Typing is debounced and answers to outdated queries are dropped.
   */
  let {
    query = $bindable(''),
    onOpen,
  }: {
    query?: string;
    onOpen: (path: string, opts: { newTab: boolean; line?: number }) => void;
  } = $props();

  let input = $state<HTMLInputElement>();
  let hits = $state.raw<SearchHit[]>([]);
  let status = $state<'idle' | 'loading' | 'done' | 'error'>('idle');
  /** The newest request wins. */
  let generation = 0;

  $effect(() => {
    const q = query.trim();
    const g = ++generation;
    if (q === '') {
      hits = [];
      status = 'idle';
      return;
    }
    status = 'loading';
    const timer = setTimeout(() => {
      api.search(q, LIMIT).then(
        (result) => {
          if (g !== generation) return;
          hits = result;
          status = 'done';
        },
        () => {
          if (g !== generation) return;
          hits = [];
          status = 'error';
        },
      );
    }, SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  });

  /** Puts the cursor into the field (Mod-Shift-f). */
  export function focus(): void {
    input?.focus();
    input?.select();
  }

  const title = (path: string) => basename(path).replace(/\.md$/i, '');
</script>

<div class="search-pane">
  <div class="field">
    <input
      bind:this={input}
      bind:value={query}
      type="search"
      class="text-input"
      aria-label={de.search.label}
      placeholder={de.search.placeholder}
      autocomplete="off"
      spellcheck="false"
    />
  </div>

  <div class="status" role="status" aria-live="polite">
    {#if status === 'loading'}
      {de.search.searching}
    {:else if status === 'done'}
      {hits.length === 0 ? de.search.none : de.search.results(hits.length)}
    {:else if status === 'error'}
      {de.search.failed}
    {/if}
  </div>

  <div class="results">
    {#each hits as hit (hit.path)}
      <section class="hit">
        <button
          type="button"
          class="file"
          title={hit.path}
          onclick={(e) => onOpen(hit.path, { newTab: e.ctrlKey || e.metaKey })}
        >
          <span class="name">{title(hit.path)}</span>
          {#if dirname(hit.path)}<span class="folder">{dirname(hit.path)}</span>{/if}
        </button>
        {#each hit.matches as m (m.line)}
          <button
            type="button"
            class="match"
            aria-label="{title(hit.path)}, {de.search.line(m.line + 1)}"
            onclick={(e) => onOpen(hit.path, { newTab: e.ctrlKey || e.metaKey, line: m.line })}
          >
            <span class="line-no" aria-hidden="true">{m.line + 1}</span>
            <span class="text">{#each segments(m.text, m.ranges) as s, i (i)}{#if s.mark}<mark>{s.text}</mark>{:else}{s.text}{/if}{/each}</span>
          </button>
        {/each}
      </section>
    {/each}
  </div>
</div>

<style>
  .search-pane {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
  }
  .field input {
    width: 100%;
    box-sizing: border-box;
  }
  .status {
    min-height: 1.5em;
    padding: var(--size-2) var(--size-2) var(--size-1);
    color: var(--text-faint);
    font-size: var(--font-ui-smaller);
  }
  .results {
    flex: 1;
    min-height: 0;
    overflow: auto;
  }
  .hit {
    margin-bottom: var(--size-3);
  }
  button {
    display: flex;
    align-items: baseline;
    gap: var(--size-2);
    width: 100%;
    padding: 2px var(--size-2);
    border: 0;
    border-radius: var(--radius-s);
    background: transparent;
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
  }
  button:hover {
    background: var(--background-modifier-hover);
  }
  .file {
    font-weight: 600;
  }
  .name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .folder {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--text-faint);
    font-size: var(--font-ui-smaller);
    font-weight: 400;
  }
  .match {
    color: var(--text-muted);
  }
  .line-no {
    flex: none;
    min-width: 2.2em;
    color: var(--text-faint);
    font-size: var(--font-ui-smaller);
    text-align: right;
  }
  .text {
    min-width: 0;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
    overflow-wrap: anywhere;
  }
  mark {
    background: var(--text-selection);
    color: var(--text-normal);
    border-radius: 2px;
  }
</style>

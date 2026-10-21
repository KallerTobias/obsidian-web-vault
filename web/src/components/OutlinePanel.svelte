<script lang="ts">
  import { parseNote } from '@shared/parse';
  import type { Heading } from '@shared/types';
  import { de } from '../lib/i18n/de';
  import type { ActiveNote } from '../lib/stores/active-note';

  /** The note's headings (parsed from the editor text, debounced while typing); a click scrolls there. */
  let { note }: { note: ActiveNote } = $props();

  const DELAY_MS = 300;
  let headings = $state<Heading[]>([]);
  let parsedPath: string | null = null;

  $effect(() => {
    const { text, path } = note;
    // A different note shows at once; typing in the same note is parsed after a pause.
    if (path !== parsedPath) {
      parsedPath = path;
      headings = parseNote(text).headings;
      return;
    }
    const id = setTimeout(() => (headings = parseNote(text).headings), DELAY_MS);
    return () => clearTimeout(id);
  });

  const minLevel = $derived(headings.reduce((m, h) => Math.min(m, h.level), 6));
</script>

{#if headings.length === 0}
  <p class="empty">{de.outline.none}</p>
{:else}
  <ul class="outline" aria-label={de.outline.label}>
    {#each headings as h (h.line)}
      <li>
        <button type="button" class="heading" style:--depth={h.level - minLevel} onclick={() => note.revealHeading({ line: h.line, text: h.text })}>
          {h.text}
        </button>
      </li>
    {/each}
  </ul>
{/if}

<style>
  .empty {
    margin: 0;
    font-size: var(--font-ui-small);
    color: var(--text-muted);
  }
  .outline {
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .heading {
    display: block;
    width: 100%;
    padding: 2px var(--size-2) 2px calc(var(--size-2) + var(--depth) * 14px);
    border: 0;
    border-radius: var(--radius-s, 4px);
    background: none;
    color: var(--text-muted);
    font: inherit;
    font-size: var(--font-ui-small);
    text-align: left;
    cursor: pointer;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .heading:hover {
    background: var(--background-modifier-hover);
    color: var(--text-normal);
  }
</style>

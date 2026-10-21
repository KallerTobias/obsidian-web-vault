<script lang="ts" module>
  const OPEN_KEY = 'vw.tags.open';
  /** Several vault events in a row reload the tags once. */
  export const REFRESH_DELAY_MS = 500;

  function loadOpen(): Set<string> {
    try {
      const v: unknown = JSON.parse(localStorage.getItem(OPEN_KEY) ?? '[]');
      return new Set(Array.isArray(v) ? v.filter((p): p is string => typeof p === 'string') : []);
    } catch {
      return new Set();
    }
  }

  function saveOpen(set: Set<string>): void {
    try {
      localStorage.setItem(OPEN_KEY, JSON.stringify([...set]));
    } catch {
      /* storage blocked: folded tags just are not remembered */
    }
  }
</script>

<script lang="ts">
  import { onMount } from 'svelte';
  import { api } from '../lib/api';
  import { t } from '../lib/i18n';
  import { events } from '../lib/stores/events';
  import { buildTagTree, type TagNode } from '../lib/tags';

  /** The vault's tags as a tree (`a/b/c`) with counts; a click searches for the tag. */
  let { onSelect }: { onSelect: (tag: string) => void } = $props();

  let tags = $state.raw<{ tag: string; count: number }[]>([]);
  let status = $state<'loading' | 'ready' | 'error'>('loading');
  let open = $state.raw(loadOpen());
  const tree = $derived(buildTagTree(tags));

  async function load(): Promise<void> {
    try {
      tags = await api.tags();
      status = 'ready';
    } catch {
      // Keep what we have when a refresh fails.
      if (status === 'loading') status = 'error';
    }
  }

  onMount(() => {
    void load();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const off = events.onAnyChange(() => {
      clearTimeout(timer);
      timer = setTimeout(() => void load(), REFRESH_DELAY_MS);
    });
    return () => {
      off();
      clearTimeout(timer);
    };
  });

  function toggle(tag: string): void {
    const next = new Set(open);
    if (!next.delete(tag)) next.add(tag);
    open = next;
    saveOpen(next);
  }
</script>

{#snippet branch(nodes: TagNode[], depth: number)}
  {#each nodes as node (node.tag)}
    {@const isOpen = open.has(node.tag)}
    <li role="treeitem" aria-expanded={node.children.length ? isOpen : undefined} aria-selected="false">
      <div class="row" style:padding-left="{depth * 14}px">
        {#if node.children.length}
          <button
            type="button"
            class="twisty"
            class:open={isOpen}
            aria-label="{isOpen ? t.tags.collapse : t.tags.expand}: {node.name}"
            onclick={() => toggle(node.tag)}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6" /></svg>
          </button>
        {:else}
          <span class="twisty-gap"></span>
        {/if}
        <button type="button" class="tag" aria-label={t.tags.count(`#${node.tag}`, node.count)} onclick={() => onSelect(node.tag)}>
          <span class="name">#{node.name}</span>
          <span class="count" aria-hidden="true">{node.count}</span>
        </button>
      </div>
      {#if node.children.length && isOpen}
        <ul role="group">{@render branch(node.children, depth + 1)}</ul>
      {/if}
    </li>
  {/each}
{/snippet}

<div class="tag-pane">
  {#if status === 'error'}
    <div role="alert">
      <p>{t.tags.loadFailed}</p>
      <button type="button" class="link-button" onclick={() => void load()}>{t.retry}</button>
    </div>
  {:else if status === 'ready' && tree.length === 0}
    <p class="empty">{t.tags.none}</p>
  {:else}
    <ul role="tree" aria-label={t.tags.label}>{@render branch(tree, 0)}</ul>
  {/if}
</div>

<style>
  ul {
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .row {
    display: flex;
    align-items: center;
  }
  button {
    border: 0;
    background: transparent;
    color: inherit;
    font: inherit;
    cursor: pointer;
  }
  .twisty,
  .twisty-gap {
    flex: none;
    width: 20px;
    height: 24px;
    padding: 0;
    color: var(--text-faint);
  }
  .twisty svg {
    width: 14px;
    height: 14px;
    transition: transform 100ms;
  }
  .twisty.open svg {
    transform: rotate(90deg);
  }
  .tag {
    display: flex;
    flex: 1;
    min-width: 0;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--size-3);
    padding: 2px var(--size-2);
    border-radius: var(--radius-s);
    text-align: left;
  }
  .tag:hover {
    background: var(--background-modifier-hover);
  }
  .name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .count {
    color: var(--text-faint);
    font-size: var(--font-ui-smaller);
  }
  .empty {
    color: var(--text-faint);
    padding: var(--size-3);
  }
</style>

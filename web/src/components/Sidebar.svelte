<script lang="ts">
  import type { Snippet } from 'svelte';

  /** A sidebar panel: small header with a title (and optional actions), scrolling content below. */
  let { title, actions, children }: { title: string; actions?: Snippet; children?: Snippet } = $props();
</script>

<div class="sidebar">
  <div class="sidebar-header">
    <h2>{title}</h2>
    {#if actions}<div class="sidebar-actions">{@render actions()}</div>{/if}
  </div>
  <div class="sidebar-content">
    {@render children?.()}
  </div>
</div>

<style>
  .sidebar {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
  }
  .sidebar-header {
    display: flex;
    align-items: center;
    gap: var(--size-3);
    min-height: 36px;
    padding: var(--size-2) var(--size-4);
  }
  h2 {
    flex: 1;
    margin: 0;
    font-size: var(--font-ui-smaller);
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--text-faint);
  }
  .sidebar-actions {
    display: flex;
    gap: 2px;
  }
  .sidebar-content {
    flex: 1;
    min-height: 0;
    overflow: auto;
    padding: 0 var(--size-3) var(--size-4);
    font-size: var(--font-ui-small);
  }
</style>

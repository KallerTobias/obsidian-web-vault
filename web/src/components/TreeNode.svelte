<script lang="ts">
  import { de } from '../lib/i18n/de';
  import { displayName, type TreeRow } from '../lib/tree';

  /**
   * One row of the file tree (presentational). FileTree handles all input on the tree element and
   * finds the row via `data-index`; keyboard focus stays on the tree (aria-activedescendant).
   */
  let {
    row,
    index,
    id,
    top,
    cursor,
    current,
    dropTarget,
  }: {
    row: TreeRow;
    index: number;
    id: string;
    /** Offset in the virtualised list (px). */
    top: number;
    /** The keyboard cursor is on this row. */
    cursor: boolean;
    /** This file is open in the active tab. */
    current: boolean;
    dropTarget: boolean;
  } = $props();

  const entry = $derived(row.entry);
  const isFolder = $derived(entry.kind === 'folder');
</script>

<div
  {id}
  class="row"
  class:cursor
  class:current
  class:drop-target={dropTarget}
  role="treeitem"
  aria-level={row.level}
  aria-posinset={row.posinset}
  aria-setsize={row.setsize}
  aria-expanded={isFolder ? row.expanded : undefined}
  aria-selected={cursor}
  aria-current={current ? 'page' : undefined}
  data-index={index}
  draggable="true"
  style:transform="translateY({top}px)"
  style:padding-left="calc({row.level - 1} * var(--tree-indent) + var(--size-2))"
  title={entry.readonly ? `${entry.path} (${de.files.readonly})` : entry.path}
>
  <span class="chevron" aria-hidden="true">
    {#if isFolder}
      <svg viewBox="0 0 24 24" class:open={row.expanded}><path d="M9 6l6 6-6 6" /></svg>
    {/if}
  </span>
  <span class="name" class:folder={isFolder} class:file={entry.kind === 'file'}>{displayName(entry)}</span>
  {#if entry.kind === 'file'}
    <span class="ext" aria-hidden="true">{entry.name.includes('.') ? entry.name.split('.').pop() : ''}</span>
  {/if}
  {#if entry.readonly}
    <svg class="lock" viewBox="0 0 24 24" aria-label={de.files.readonly} role="img">
      <rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </svg>
  {/if}
</div>

<style>
  .row {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    display: flex;
    align-items: center;
    gap: 2px;
    height: var(--tree-row-height);
    padding-right: var(--size-3);
    border-radius: var(--radius-s);
    color: var(--text-muted);
    cursor: pointer;
    white-space: nowrap;
    user-select: none;
    -webkit-user-select: none;
    -webkit-touch-callout: none;
  }
  .row:hover {
    background: var(--background-modifier-hover);
    color: var(--text-normal);
  }
  .row.current {
    background: var(--background-modifier-active);
    color: var(--text-normal);
  }
  .row.cursor {
    outline: 2px solid var(--focus-ring);
    outline-offset: -2px;
  }
  .row.drop-target {
    background: var(--text-selection);
  }
  .chevron {
    flex: none;
    display: grid;
    place-items: center;
    width: 16px;
    height: 16px;
    color: var(--text-faint);
  }
  .chevron svg {
    width: 12px;
    height: 12px;
    fill: none;
    stroke: currentColor;
    stroke-width: 2.5;
    transition: transform 120ms ease;
  }
  .chevron svg.open {
    transform: rotate(90deg);
  }
  .name {
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .name.folder {
    color: var(--text-normal);
  }
  .ext {
    flex: none;
    margin-left: auto;
    padding: 0 4px;
    border-radius: var(--radius-s);
    background: var(--background-modifier-hover);
    color: var(--text-faint);
    font-size: var(--font-ui-smaller);
    text-transform: uppercase;
  }
  .lock {
    flex: none;
    width: 12px;
    height: 12px;
    margin-left: auto;
    fill: none;
    stroke: var(--text-faint);
    stroke-width: 2;
  }
  .ext + .lock {
    margin-left: 4px;
  }
</style>

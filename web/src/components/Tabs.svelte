<script lang="ts" module>
  import { basename } from '@shared/normalize';
  import { de } from '../lib/i18n/de';
  import type { Tab } from '../lib/stores/workspace';

  export function tabTitle(tab: Tab): string {
    if (tab.kind === 'graph') return de.tabs.graph;
    if (tab.kind === 'settings') return de.tabs.settings;
    const name = basename(tab.path ?? '');
    return tab.kind === 'note' ? name.replace(/\.md$/i, '') : name;
  }

  export const tabId = (i: number) => `tab-${i}`;
  export const panelId = 'tab-panel';
</script>

<script lang="ts">
  import { workspace } from '../lib/stores/workspace';

  /**
   * Back/forward for the active tab and the tab strip (`role="tablist"`). Arrow keys move between
   * tabs (roving tabindex), Delete closes the focused tab, a middle click closes a tab.
   */
  let strip = $state<HTMLDivElement>();
  const active = $derived($workspace.tabs[$workspace.active]);

  function focusTab(i: number): void {
    const n = $workspace.tabs.length;
    if (!n) return;
    const j = (i + n) % n;
    workspace.activate(j);
    strip?.querySelector<HTMLElement>(`#${tabId(j)}`)?.focus();
  }

  function onkeydown(e: KeyboardEvent, i: number): void {
    switch (e.key) {
      case 'ArrowRight':
        focusTab(i + 1);
        break;
      case 'ArrowLeft':
        focusTab(i - 1);
        break;
      case 'Home':
        focusTab(0);
        break;
      case 'End':
        focusTab(-1);
        break;
      case 'Delete':
        workspace.close(i);
        queueMicrotask(() => focusTab($workspace.active));
        break;
      default:
        return;
    }
    e.preventDefault();
  }
</script>

<div class="tab-bar">
  <div class="nav">
    <button
      type="button"
      class="icon-button"
      aria-label={de.tabs.back}
      title={de.tabs.back}
      disabled={!active || active.pos <= 0}
      onclick={() => workspace.back()}
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 18l-6-6 6-6" /></svg>
    </button>
    <button
      type="button"
      class="icon-button"
      aria-label={de.tabs.forward}
      title={de.tabs.forward}
      disabled={!active || active.pos >= active.history.length - 1}
      onclick={() => workspace.forward()}
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 18l6-6-6-6" /></svg>
    </button>
  </div>

  <div bind:this={strip} class="tabs" role="tablist" aria-label={de.tabs.label}>
    {#each $workspace.tabs as tab, i (i)}
      {@const title = tabTitle(tab)}
      {@const selected = i === $workspace.active}
      <div class="tab" class:selected class:deleted={tab.deleted}>
        <button
          type="button"
          id={tabId(i)}
          role="tab"
          class="tab-label"
          aria-selected={selected}
          aria-controls={selected ? panelId : undefined}
          tabindex={selected ? 0 : -1}
          title={tab.path ?? title}
          onclick={() => workspace.activate(i)}
          onauxclick={(e) => {
            if (e.button === 1) workspace.close(i);
          }}
          onmousedown={(e) => {
            if (e.button === 1) e.preventDefault();
          }}
          onkeydown={(e) => onkeydown(e, i)}
        >
          {title}{#if tab.deleted}<span class="visually-hidden"> {de.tabs.deletedSuffix}</span>{/if}
        </button>
        <button type="button" class="close" tabindex="-1" aria-label={de.tabs.close(title)} title={de.tabs.close(title)} onclick={() => workspace.close(i)}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
        </button>
      </div>
    {/each}
  </div>
</div>

<style>
  .tab-bar {
    display: flex;
    align-items: stretch;
    min-height: 36px;
    border-bottom: 1px solid var(--background-modifier-border);
    background: var(--background-secondary);
  }
  .nav {
    display: flex;
    align-items: center;
    gap: 2px;
    padding: 0 var(--size-2);
  }
  .nav .icon-button:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .tabs {
    display: flex;
    flex: 1;
    min-width: 0;
    overflow-x: auto;
    scrollbar-width: thin;
  }
  .tab {
    display: flex;
    align-items: center;
    flex: 0 1 200px;
    min-width: 90px;
    border-right: 1px solid var(--background-modifier-border);
    color: var(--text-muted);
  }
  .tab.selected {
    background: var(--background-primary);
    color: var(--text-normal);
  }
  .tab.deleted .tab-label {
    text-decoration: line-through;
    color: var(--text-faint);
  }
  .tab-label {
    flex: 1;
    min-width: 0;
    height: 100%;
    padding: 0 var(--size-2) 0 var(--size-4);
    border: 0;
    background: none;
    color: inherit;
    font: inherit;
    font-size: var(--font-ui-small);
    text-align: left;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    cursor: pointer;
  }
  .close {
    display: grid;
    place-items: center;
    width: 22px;
    height: 22px;
    margin-right: var(--size-2);
    padding: 0;
    border: 0;
    border-radius: var(--radius-s);
    background: none;
    color: var(--text-faint);
    cursor: pointer;
  }
  .close:hover {
    background: var(--background-modifier-hover);
    color: var(--text-normal);
  }
  .close svg {
    width: 14px;
    height: 14px;
  }
</style>

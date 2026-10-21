<script lang="ts" module>
  export type SidebarView = 'files' | 'search' | 'tags';
</script>

<script lang="ts">
  import { de } from '../lib/i18n/de';

  /** The sidebar's view tabs plus the "Graph" action (opens the graph tab; not a sidebar view). */
  let { view, onSelect, onGraph }: { view: SidebarView; onSelect: (view: SidebarView) => void; onGraph: () => void } = $props();

  const VIEWS: { id: SidebarView; label: string; icon: string }[] = [
    { id: 'files', label: de.sidebar.files, icon: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z' },
    { id: 'search', label: de.sidebar.search, icon: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM21 21l-4.3-4.3' },
    { id: 'tags', label: de.sidebar.tags, icon: 'M4 9h16M4 15h16M10 3L8 21M16 3l-2 18' },
  ];
</script>

<div class="views">
  <div class="tabs" role="tablist" aria-label={de.sidebar.views}>
    {#each VIEWS as v (v.id)}
      <button
        type="button"
        class="icon-button"
        role="tab"
        id="view-tab-{v.id}"
        aria-selected={view === v.id}
        aria-controls="view-{v.id}"
        aria-label={v.label}
        title={v.label}
        onclick={() => onSelect(v.id)}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d={v.icon} /></svg>
      </button>
    {/each}
  </div>
  <button type="button" class="icon-button graph" aria-label={de.sidebar.openGraph} title={de.sidebar.openGraph} onclick={onGraph}>
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <circle cx="6" cy="6" r="2.5" /><circle cx="18" cy="8" r="2.5" /><circle cx="12" cy="18" r="2.5" />
      <path d="M8.2 7.2l7.6.4M7.2 8.2l3.6 7.6M16.8 10.2l-3.6 5.6" />
    </svg>
  </button>
</div>

<style>
  .views {
    display: flex;
    gap: var(--size-3);
    padding: var(--size-2) var(--size-3) 0;
  }
  .tabs {
    display: flex;
    gap: 2px;
  }
  .tabs [aria-selected='true'] {
    background: var(--background-modifier-hover);
    color: var(--text-normal);
  }
</style>

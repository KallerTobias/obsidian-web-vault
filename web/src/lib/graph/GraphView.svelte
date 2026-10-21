<script lang="ts" module>
  const SIDEBAR_KEY = 'vw.graph.sidebar';

  function loadSidebarOpen(): boolean {
    try {
      return localStorage.getItem(SIDEBAR_KEY) !== 'closed';
    } catch {
      return true;
    }
  }

  function saveSidebarOpen(open: boolean): void {
    try {
      localStorage.setItem(SIDEBAR_KEY, open ? 'open' : 'closed');
    } catch {
      /* storage blocked: not remembered */
    }
  }
</script>

<script lang="ts">
  import { untrack } from 'svelte';
  import type { GraphData } from '../api';
  import { de } from '../i18n/de';
  import { graphSettings, watchGraph } from '../stores/graph';
  import { filterGraph } from './data';
  import GraphCanvas from './GraphCanvas.svelte';
  import GraphSettingsPanel from './GraphSettings.svelte';

  /** The graph tab: the whole vault as a graph (2D or 3D) with a collapsible settings sidebar. */
  let {
    onOpen,
    onTag,
    onUnresolved,
  }: {
    onOpen?: (path: string, newTab: boolean) => void;
    onTag?: (tag: string) => void;
    onUnresolved?: (name: string, newTab: boolean) => void;
  } = $props();

  const MODES = [
    ['2d', de.graph.mode2d],
    ['3d', de.graph.mode3d],
  ] as const;

  let raw = $state.raw<GraphData | null>(null);
  let failed = $state(false);
  let sidebarOpen = $state(loadSidebarOpen());

  $effect(() => {
    graphSettings.load().catch(() => {
      /* defaults until the next load */
    });
    const stop = watchGraph(
      (g) => {
        raw = g;
        failed = false;
      },
      () => (failed = true),
    );
    return () => {
      stop();
      graphSettings.flush();
    };
  });

  /** Only the filter-related settings refilter (sliders and colours must not reset the data). */
  const filterKey = $derived(
    JSON.stringify([$graphSettings.filter, $graphSettings.showTags, $graphSettings.showAttachments, $graphSettings.showOrphans]),
  );
  const shown = $derived.by(() => {
    void filterKey;
    const data = raw;
    return data ? untrack(() => filterGraph(data, $graphSettings)) : null;
  });

  function toggleSidebar(): void {
    sidebarOpen = !sidebarOpen;
    saveSidebarOpen(sidebarOpen);
  }
</script>

<div class="graph-view">
  <div class="stage">
    {#if failed && !raw}
      <p class="message" role="alert">{de.graph.loadFailed}</p>
    {:else if !shown}
      <p class="message">{de.graph.loading}</p>
    {:else}
      <GraphCanvas data={shown} settings={$graphSettings} mode={$graphSettings.mode} {onOpen} {onTag} {onUnresolved} />
      {#if shown.nodes.length === 0}<p class="message overlay">{de.graph.empty}</p>{/if}
    {/if}
    <div class="controls">
      <div class="modes" role="group" aria-label={de.graph.mode}>
        {#each MODES as [m, text] (m)}
          <button type="button" aria-pressed={$graphSettings.mode === m} onclick={() => graphSettings.update({ mode: m })}>{text}</button>
        {/each}
      </div>
      <button
        type="button"
        class="icon-button"
        aria-label={de.graph.toggleSettings}
        title={de.graph.toggleSettings}
        aria-expanded={sidebarOpen}
        aria-controls="graph-settings"
        onclick={toggleSidebar}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0" /><circle cx="16" cy="6" r="2" /><circle cx="10" cy="12" r="2" /><circle cx="18" cy="18" r="2" />
        </svg>
      </button>
    </div>
  </div>
  {#if sidebarOpen}
    <aside id="graph-settings" class="sidebar" aria-label={de.graph.settings}>
      <GraphSettingsPanel settings={$graphSettings} onChange={(patch) => graphSettings.update(patch)} />
    </aside>
  {/if}
</div>

<style>
  .graph-view {
    position: relative;
    display: flex;
    height: 100%;
    min-height: 0;
  }
  .stage {
    position: relative;
    flex: 1;
    min-width: 0;
  }
  .sidebar {
    flex: none;
    width: 280px;
    overflow-y: auto;
    border-left: 1px solid var(--background-modifier-border);
    background: var(--background-secondary);
  }
  .controls {
    position: absolute;
    top: var(--size-3);
    right: var(--size-3);
    display: flex;
    align-items: center;
    gap: var(--size-3);
  }
  .modes {
    display: flex;
    border: 1px solid var(--background-modifier-border);
    border-radius: var(--radius-s);
    overflow: hidden;
  }
  .modes button {
    padding: 2px var(--size-3);
    border: 0;
    background: var(--background-secondary);
    color: var(--text-muted);
    font-size: var(--font-ui-small);
    cursor: pointer;
  }
  .modes button[aria-pressed='true'] {
    background: var(--interactive-accent);
    color: var(--text-on-accent);
  }
  .message {
    margin: 0;
    padding: var(--size-6);
    color: var(--text-faint);
    text-align: center;
  }
  .message.overlay {
    position: absolute;
    inset: 40% 0 auto;
    pointer-events: none;
  }
  /* Narrow windows: the settings float over the graph. */
  @media (max-width: 699.98px) {
    .sidebar {
      position: absolute;
      inset: 44px 0 0 auto;
      z-index: 2;
      width: min(85%, 280px);
      box-shadow: var(--shadow-l);
    }
  }
</style>

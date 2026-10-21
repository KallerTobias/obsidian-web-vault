<script lang="ts" module>
  type Section = 'properties' | 'backlinks' | 'outline' | 'graph';
  const SECTIONS: Section[] = ['properties', 'backlinks', 'outline', 'graph'];
  const KEY = 'vw.rightPanel.collapsed';

  function loadCollapsed(): Section[] {
    try {
      const v: unknown = JSON.parse(localStorage.getItem(KEY) ?? '[]');
      return Array.isArray(v) ? SECTIONS.filter((s) => v.includes(s)) : [];
    } catch {
      return [];
    }
  }

  function saveCollapsed(list: Section[]): void {
    try {
      localStorage.setItem(KEY, JSON.stringify(list));
    } catch {
      /* storage blocked: the sections are just not remembered */
    }
  }
</script>

<script lang="ts">
  import type { GraphData } from '../lib/api';
  import { t } from '../lib/i18n';
  import { activeNote } from '../lib/stores/active-note';
  import { graphSettings, watchGraph } from '../lib/stores/graph';
  import { vault } from '../lib/stores/vault';
  import { workspace } from '../lib/stores/workspace';
  import BacklinksPanel from './BacklinksPanel.svelte';
  import LocalGraph from './LocalGraph.svelte';
  import OutlinePanel from './OutlinePanel.svelte';
  import PropertiesPanel from './PropertiesPanel.svelte';

  /** Right sidebar: properties, backlinks, outline and local graph of the active tab's note. */
  const titles: Record<Section, string> = {
    properties: t.panel.properties,
    backlinks: t.panel.backlinks,
    outline: t.panel.outline,
    graph: t.panel.localGraph,
  };

  let collapsed = $state<Section[]>(loadCollapsed());
  const tab = $derived($workspace.tabs[$workspace.active]);
  const path = $derived(tab?.kind === 'note' && !tab.deleted ? tab.path : undefined);
  /** The editor of this note (properties and outline work on its text, including unsaved edits). */
  const note = $derived($activeNote && $activeNote.path === path ? $activeNote : null);
  const { lookup } = vault;
  const aliases = $derived((path && $lookup.find((e) => e.path === path)?.aliases) || []);

  let graph = $state<GraphData | null>(null);
  let graphFailed = $state(false);
  const graphOpen = $derived(!collapsed.includes('graph'));

  function toggle(s: Section): void {
    collapsed = collapsed.includes(s) ? collapsed.filter((x) => x !== s) : [...collapsed, s];
    saveCollapsed(collapsed);
  }

  // The graph is the whole vault: only loaded while its section is open, and again after changes.
  const hasNote = $derived(Boolean(path));
  $effect(() => {
    if (!graphOpen || !hasNote) return;
    graphSettings.load().catch(() => {
      /* defaults (depth 1) */
    });
    return watchGraph(
      (g) => {
        graph = g;
        graphFailed = false;
      },
      () => (graphFailed = true),
    );
  });

  const openNote = (target: string, line: number | undefined, newTab: boolean) => workspace.open(target, { line, newTab });
</script>

{#if !path}
  <p class="empty">{t.panel.noNote}</p>
{:else}
  <div class="right-panel">
    {#each SECTIONS as s (s)}
      <section class="section">
        <h3>
          <button type="button" class="section-header" aria-expanded={!collapsed.includes(s)} onclick={() => toggle(s)}>
            <span class="chevron" aria-hidden="true">{collapsed.includes(s) ? '▸' : '▾'}</span>
            {titles[s]}
          </button>
        </h3>
        {#if !collapsed.includes(s)}
          <div class="section-body">
            {#if s === 'backlinks'}
              <BacklinksPanel {path} {aliases} onOpen={(source, line, newTab) => openNote(source, line, newTab)} />
            {:else if s === 'graph'}
              {#if graphFailed}
                <p class="empty" role="alert">{t.localGraph.loadFailed}</p>
              {:else}
                <LocalGraph data={graph} settings={$graphSettings} mode="local" highlight={path} onOpen={(p, newTab) => openNote(p, undefined, newTab)} />
              {/if}
            {:else if !note}
              <p class="empty">{t.panel.loading}</p>
            {:else if s === 'properties'}
              <PropertiesPanel {note} />
            {:else}
              <OutlinePanel {note} />
            {/if}
          </div>
        {/if}
      </section>
    {/each}
  </div>
{/if}

<style>
  .empty {
    margin: 0;
    padding: var(--size-2) 0;
    font-size: var(--font-ui-small);
    color: var(--text-muted);
  }
  .section + .section {
    border-top: 1px solid var(--background-modifier-border);
  }
  h3 {
    margin: 0;
  }
  .section-header {
    display: flex;
    align-items: center;
    gap: var(--size-2);
    width: 100%;
    padding: var(--size-2) 0;
    border: 0;
    background: none;
    color: var(--text-faint);
    font: inherit;
    font-size: var(--font-ui-smaller);
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    cursor: pointer;
  }
  .section-header:hover {
    color: var(--text-normal);
  }
  .section-body {
    padding-bottom: var(--size-3);
  }
</style>

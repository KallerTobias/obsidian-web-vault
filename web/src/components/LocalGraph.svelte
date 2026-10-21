<script lang="ts">
  import { untrack } from 'svelte';
  import { basename } from '@shared/normalize';
  import type { GraphData, Settings } from '../lib/api';
  import { filterGraph, localGraph } from '../lib/graph/data';
  import GraphCanvas from '../lib/graph/GraphCanvas.svelte';
  import { t } from '../lib/i18n';
  import { DEFAULT_GRAPH_SETTINGS } from '../lib/stores/graph';

  /**
   * Small 2D graph for the right panel: in `local` mode `highlight` and everything within
   * `settings.localDepth` links of it (tags/attachments as the graph settings show them; the
   * filter is not applied, so the note itself never disappears).
   */
  let {
    data,
    settings = DEFAULT_GRAPH_SETTINGS,
    mode = 'local',
    highlight,
    onOpen,
  }: {
    data: GraphData | null;
    settings?: Settings['graph'];
    mode?: 'local' | 'global';
    highlight?: string;
    onOpen?: (path: string, newTab: boolean) => void;
  } = $props();

  /** Only these settings change which nodes are shown (forces and colours must not reset the layout). */
  const shapeKey = $derived(
    JSON.stringify([settings.filter, settings.showTags, settings.showAttachments, settings.showOrphans, settings.localDepth]),
  );
  const shown = $derived.by(() => {
    void shapeKey;
    const center = highlight;
    if (!data) return null;
    const s = untrack(() => settings);
    if (mode === 'global') return filterGraph(data, s);
    if (!center) return null;
    const visible = filterGraph(data, { ...s, filter: '', showOrphans: true });
    return localGraph(visible, center, s.localDepth);
  });
  /** The connected notes and files, also as a list for keyboard and screen reader users. */
  const linked = $derived((shown?.nodes ?? []).filter((n) => n.id !== highlight && (n.kind === 'note' || n.kind === 'attachment')));
</script>

<div class="local-graph">
  {#if shown && shown.nodes.length > 0}
    <div class="canvas">
      <GraphCanvas
        data={shown}
        {settings}
        mode="2d"
        {highlight}
        fit
        label={highlight ? t.graph.localLabel(basename(highlight).replace(/\.md$/i, '')) : t.graph.label}
        {onOpen}
      />
    </div>
  {/if}
  {#if shown && linked.length === 0}
    <p class="hint">{t.localGraph.none}</p>
  {/if}
  {#if linked.length > 0}
    <ul class="node-list">
      {#each linked as n (n.id)}
        <li>
          <button type="button" title={n.id} onclick={(e) => onOpen?.(n.id, e.ctrlKey || e.metaKey)}>{n.name}</button>
        </li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  .canvas {
    height: 240px;
    border-radius: var(--radius-m);
    background: var(--background-primary);
    overflow: hidden;
  }
  /* Shown only while it has keyboard focus (screen readers always get it). */
  .node-list {
    margin: var(--size-2) 0 0;
    padding: 0;
    list-style: none;
  }
  .node-list:not(:focus-within) {
    position: absolute;
    width: 1px;
    height: 1px;
    margin: -1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
  .node-list button {
    display: block;
    width: 100%;
    padding: 2px var(--size-2);
    border: 0;
    border-radius: var(--radius-s);
    background: none;
    color: var(--text-muted);
    font-size: var(--font-ui-small);
    text-align: left;
    cursor: pointer;
  }
  .hint {
    margin: var(--size-2) 0 0;
    font-size: var(--font-ui-small);
    color: var(--text-faint);
  }
</style>

<script lang="ts" module>
  /** Colours offered for new groups, in turn. */
  export const GROUP_COLORS = ['#e03131', '#2f9e44', '#1971c2', '#f08c00', '#9c36b5', '#0c8599'];
</script>

<script lang="ts">
  import { t } from '../i18n';
  import type { GraphGroup, GraphSettings } from './data';

  /** Sidebar of the graph tab: filter, switches, colour groups, forces, sizes. Every change goes to `onChange`. */
  let { settings, onChange }: { settings: GraphSettings; onChange: (patch: Partial<GraphSettings>) => void } = $props();

  type Slider = 'repel' | 'linkDistance' | 'center' | 'nodeSize';
  const forces: { key: Slider; label: string; min: number; max: number }[] = [
    { key: 'repel', label: t.graph.repel, min: 0.1, max: 3 },
    { key: 'linkDistance', label: t.graph.linkDistance, min: 0.1, max: 3 },
    { key: 'center', label: t.graph.center, min: 0, max: 3 },
  ];

  function setGroups(groups: GraphGroup[]): void {
    onChange({ groups });
  }

  function editGroup(i: number, patch: Partial<GraphGroup>): void {
    setGroups(settings.groups.map((g, j) => (j === i ? { ...g, ...patch } : g)));
  }

  function moveGroup(i: number, delta: number): void {
    const j = i + delta;
    if (j < 0 || j >= settings.groups.length) return;
    const groups = settings.groups.slice();
    [groups[i], groups[j]] = [groups[j]!, groups[i]!];
    setGroups(groups);
  }

  function addGroup(): void {
    setGroups([...settings.groups, { query: '', color: GROUP_COLORS[settings.groups.length % GROUP_COLORS.length]! }]);
  }

  const num = (e: Event) => Number((e.currentTarget as HTMLInputElement).value);
</script>

{#snippet slider(key: Slider, label: string, min: number, max: number)}
  <label class="slider">
    <span>{label} <output>{settings[key].toFixed(1)}</output></span>
    <input type="range" {min} {max} step="0.1" value={settings[key]} oninput={(e) => onChange({ [key]: num(e) })} />
  </label>
{/snippet}

<div class="graph-settings">
  <section>
    <h3>{t.graph.filters}</h3>
    <input
      type="search"
      class="text"
      aria-label={t.graph.filter}
      placeholder={t.graph.filterPlaceholder}
      value={settings.filter}
      oninput={(e) => onChange({ filter: e.currentTarget.value })}
    />
    <label class="switch">
      <input type="checkbox" checked={settings.showTags} onchange={(e) => onChange({ showTags: e.currentTarget.checked })} />
      {t.graph.showTags}
    </label>
    <label class="switch">
      <input type="checkbox" checked={settings.showAttachments} onchange={(e) => onChange({ showAttachments: e.currentTarget.checked })} />
      {t.graph.showAttachments}
    </label>
    <label class="switch">
      <input type="checkbox" checked={settings.showOrphans} onchange={(e) => onChange({ showOrphans: e.currentTarget.checked })} />
      {t.graph.showOrphans}
    </label>
  </section>

  <section>
    <h3>{t.graph.groups}</h3>
    <ol class="groups">
      {#each settings.groups as group, i (i)}
        {@const n = i + 1}
        <li>
          <input
            type="color"
            aria-label={t.graph.groupColor(n)}
            value={group.color}
            oninput={(e) => editGroup(i, { color: e.currentTarget.value })}
          />
          <input
            type="text"
            class="text"
            aria-label={t.graph.groupQuery(n)}
            placeholder={t.graph.groupPlaceholder}
            value={group.query}
            oninput={(e) => editGroup(i, { query: e.currentTarget.value })}
          />
          <button type="button" class="icon-button" aria-label={t.graph.groupUp(n)} title={t.graph.groupUp(n)} disabled={i === 0} onclick={() => moveGroup(i, -1)}>↑</button>
          <button
            type="button"
            class="icon-button"
            aria-label={t.graph.groupDown(n)}
            title={t.graph.groupDown(n)}
            disabled={i === settings.groups.length - 1}
            onclick={() => moveGroup(i, 1)}>↓</button
          >
          <button
            type="button"
            class="icon-button"
            aria-label={t.graph.groupRemove(n)}
            title={t.graph.groupRemove(n)}
            onclick={() => setGroups(settings.groups.filter((_, j) => j !== i))}>×</button
          >
        </li>
      {/each}
    </ol>
    <button type="button" class="add" onclick={addGroup}>{t.graph.groupAdd}</button>
  </section>

  <section>
    <h3>{t.graph.display}</h3>
    {@render slider('nodeSize', t.graph.nodeSize, 0.3, 3)}
    <label class="slider">
      <span>{t.graph.localDepth} <output>{settings.localDepth}</output></span>
      <input type="range" min="1" max="5" step="1" value={settings.localDepth} oninput={(e) => onChange({ localDepth: num(e) })} />
    </label>
  </section>

  <section>
    <h3>{t.graph.forces}</h3>
    {#each forces as f (f.key)}
      {@render slider(f.key, f.label, f.min, f.max)}
    {/each}
  </section>
</div>

<style>
  .graph-settings {
    display: flex;
    flex-direction: column;
    gap: var(--size-4);
    padding: var(--size-4);
    font-size: var(--font-ui-small);
  }
  section {
    display: flex;
    flex-direction: column;
    gap: var(--size-3);
  }
  h3 {
    margin: 0;
    font-size: var(--font-ui-smaller);
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--text-faint);
  }
  .text {
    min-width: 0;
    padding: var(--size-2) var(--size-3);
    border: 1px solid var(--background-modifier-border);
    border-radius: var(--radius-s);
    background: var(--background-primary);
  }
  .switch {
    display: flex;
    align-items: center;
    gap: var(--size-3);
  }
  .groups {
    display: flex;
    flex-direction: column;
    gap: var(--size-2);
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .groups li {
    display: flex;
    align-items: center;
    gap: 2px;
  }
  .groups .text {
    flex: 1;
  }
  input[type='color'] {
    flex: none;
    width: 28px;
    height: 28px;
    padding: 0;
    border: 0;
    background: none;
    cursor: pointer;
  }
  .groups .icon-button:disabled {
    opacity: 0.35;
    cursor: default;
  }
  .add {
    align-self: flex-start;
    padding: var(--size-2) var(--size-3);
    border: 1px solid var(--background-modifier-border);
    border-radius: var(--radius-s);
    background: var(--background-primary);
    cursor: pointer;
  }
  .add:hover {
    background: var(--background-modifier-hover);
  }
  .slider {
    display: flex;
    flex-direction: column;
    gap: var(--size-2);
  }
  .slider span {
    display: flex;
    justify-content: space-between;
    color: var(--text-muted);
  }
  output {
    font-variant-numeric: tabular-nums;
    color: var(--text-faint);
  }
  input[type='range'] {
    width: 100%;
    accent-color: var(--interactive-accent);
  }
</style>

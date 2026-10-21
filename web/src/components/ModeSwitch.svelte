<script lang="ts" module>
  export type ViewMode = 'live' | 'reading' | 'source';
</script>

<script lang="ts">
  import { t } from '../lib/i18n';

  /** Bearbeiten (live) / Lesen / Quelltext. */
  let { mode, onChange }: { mode: ViewMode; onChange: (mode: ViewMode) => void } = $props();

  const modes: { id: ViewMode; label: string }[] = [
    { id: 'live', label: t.editor.live },
    { id: 'reading', label: t.editor.reading },
    { id: 'source', label: t.editor.source },
  ];
</script>

<div class="mode-switch" role="group" aria-label={t.editor.modes} title={t.editor.modeShortcut}>
  {#each modes as m (m.id)}
    <button type="button" aria-pressed={mode === m.id} onclick={() => onChange(m.id)}>{m.label}</button>
  {/each}
</div>

<style>
  .mode-switch {
    display: inline-flex;
    border: 1px solid var(--background-modifier-border);
    border-radius: var(--radius-s);
    overflow: hidden;
  }
  button {
    padding: var(--size-2) var(--size-3);
    border: 0;
    background: transparent;
    color: var(--text-muted);
    font: inherit;
    font-size: var(--font-ui-smaller);
    cursor: pointer;
  }
  button + button {
    border-left: 1px solid var(--background-modifier-border);
  }
  button:hover {
    background: var(--background-modifier-hover);
  }
  button[aria-pressed='true'] {
    background: var(--background-modifier-active);
    color: var(--text-normal);
  }
  button:focus-visible {
    outline: 2px solid var(--focus-ring);
    outline-offset: -2px;
  }
</style>

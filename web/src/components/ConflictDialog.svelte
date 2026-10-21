<script lang="ts">
  import { basename } from '@shared/normalize';
  import { onMount } from 'svelte';
  import { lineDiff } from '../lib/editor/diff';
  import { conflictCopyPath, type Conflict } from '../lib/editor/save';
  import { de } from '../lib/i18n/de';

  /**
   * A save conflict: my text vs. the disk version as a line diff, and the three ways out. Modal and
   * not dismissable – the editor stays blocked for saving until one is chosen.
   */
  let {
    path,
    conflict,
    onResolve,
  }: {
    path: string;
    conflict: Conflict;
    /** Rejects when the choice could not be carried out (stays open, shows an error). */
    onResolve: (choice: 'mine' | 'disk' | 'both') => Promise<void>;
  } = $props();

  let dialog = $state<HTMLDialogElement>();
  let busy = $state(false);
  let failed = $state(false);
  const diff = $derived(lineDiff(conflict.mine, conflict.diskContent ?? ''));
  const copyName = $derived(basename(conflictCopyPath(path, new Date())));

  onMount(() => {
    if (!dialog || dialog.open) return;
    // jsdom (tests) has no showModal.
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.setAttribute('open', '');
  });

  async function choose(choice: 'mine' | 'disk' | 'both'): Promise<void> {
    if (busy) return;
    busy = true;
    failed = false;
    try {
      await onResolve(choice);
    } catch {
      failed = true;
    } finally {
      busy = false;
    }
  }
</script>

<dialog bind:this={dialog} class="conflict-dialog" aria-labelledby="conflict-title" aria-describedby="conflict-intro" oncancel={(e) => e.preventDefault()}>
  <h2 id="conflict-title">{de.conflict.title}</h2>
  <p class="path">{path}</p>
  <p id="conflict-intro">{conflict.diskVersion === null ? de.conflict.deletedIntro : de.conflict.intro}</p>
  <p class="legend">
    <span class="mark mine" aria-hidden="true">−</span>
    {de.conflict.legendMine}
    <span class="mark disk" aria-hidden="true">+</span>
    {de.conflict.legendDisk}
  </p>
  <!-- Scrollable diff: focusable so keyboard users can scroll it. -->
  <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
  <div class="diff" role="region" aria-label={de.conflict.diffLabel} tabindex="0">
    {#each diff as line, i (i)}
      <div class="line {line.type}">
        <span class="mark" aria-hidden="true">{line.type === 'mine' ? '−' : line.type === 'disk' ? '+' : ' '}</span>
        {#if line.type !== 'same'}<span class="visually-hidden">{line.type === 'mine' ? de.conflict.mineMark : de.conflict.diskMark}</span>{/if}
        <span class="text">{line.text || ' '}</span>
      </div>
    {/each}
  </div>
  <p class="hint">{de.conflict.keepBothHint(copyName)}</p>
  {#if failed}<p class="error-message" role="alert">{de.conflict.failed}</p>{/if}
  <div class="buttons">
    <button type="button" class="link-button" disabled={busy} onclick={() => choose('both')}>{de.conflict.keepBoth}</button>
    <button type="button" class="link-button" disabled={busy} onclick={() => choose('disk')}>{de.conflict.keepDisk}</button>
    <button type="button" class="button-primary" disabled={busy} onclick={() => choose('mine')}>{de.conflict.keepMine}</button>
  </div>
  {#if busy}<p class="hint" role="status">{de.conflict.busy}</p>{/if}
</dialog>

<style>
  .conflict-dialog {
    width: min(760px, calc(100vw - 32px));
    max-height: calc(100vh - 64px);
    padding: var(--size-6);
    border: 1px solid var(--background-modifier-border);
    border-radius: var(--radius-l);
    background: var(--background-primary);
    color: var(--text-normal);
    box-shadow: var(--shadow-l);
  }
  .conflict-dialog[open] {
    display: flex;
    flex-direction: column;
  }
  .conflict-dialog::backdrop {
    background: var(--background-modifier-cover);
  }
  h2 {
    margin: 0 0 var(--size-2);
    font-size: var(--font-ui-medium);
  }
  p {
    margin: 0 0 var(--size-3);
    font-size: var(--font-ui-small);
  }
  .path {
    color: var(--text-faint);
    font-size: var(--font-ui-smaller);
    overflow-wrap: anywhere;
  }
  .legend {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--size-2) var(--size-3);
    color: var(--text-muted);
  }
  .diff {
    flex: 1;
    min-height: 120px;
    overflow: auto;
    border: 1px solid var(--background-modifier-border);
    border-radius: var(--radius-s);
    font-family: var(--font-monospace);
    font-size: var(--font-ui-smaller);
    line-height: 1.5;
  }
  .diff:focus-visible {
    outline: 2px solid var(--focus-ring);
  }
  .line {
    display: flex;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .mark {
    flex: none;
    width: 1.5em;
    text-align: center;
    user-select: none;
  }
  .line.mine,
  .legend .mark.mine {
    background: var(--background-modifier-error-soft);
  }
  .line.disk,
  .legend .mark.disk {
    background: rgba(8, 185, 78, 0.14);
  }
  .hint {
    margin-top: var(--size-3);
    color: var(--text-faint);
  }
  .buttons {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    align-items: center;
    gap: var(--size-4);
    margin-top: var(--size-3);
  }
  .buttons .button-primary {
    width: auto;
  }
</style>

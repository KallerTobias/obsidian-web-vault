<script lang="ts">
  import { updateFrontmatter, type FmChange } from '@shared/frontmatter';
  import { tick } from 'svelte';
  import { t } from '../lib/i18n';
  import { readProperties } from '../lib/properties';
  import type { ActiveNote } from '../lib/stores/active-note';
  import PropertyField from './PropertyField.svelte';

  /**
   * The note's frontmatter as editable properties. Every change goes through `updateFrontmatter` (only the
   * touched lines change) and `note.edit` (the editor: undo, saving) — never to the server directly.
   */
  let { note }: { note: ActiveNote } = $props();

  const properties = $derived(readProperties(note.text));
  let error = $state('');
  let adding = $state(false);
  let newKey = $state<HTMLInputElement>();

  // A message or half-added property belongs to the note it was made in.
  $effect(() => {
    void note.path;
    error = '';
    adding = false;
  });

  /** A refusal worded for the user (shown as is). */
  class Refusal extends Error {}

  function keysOf(text: string): string[] {
    const p = readProperties(text);
    return p.state === 'ok' ? p.entries.map(([k]) => k) : [];
  }

  function valueOf(text: string, key: string): unknown {
    const p = readProperties(text);
    return p.state === 'ok' ? p.entries.find(([k]) => k === key)?.[1] : undefined;
  }

  /** Applies the changes `build` returns for the editor's current text; false when refused or failed. */
  function apply(build: (text: string) => FmChange[]): boolean {
    error = '';
    try {
      note.edit((text) => updateFrontmatter(text, build(text)));
      return true;
    } catch (e) {
      error = e instanceof Refusal ? e.message : t.properties.failed(e instanceof Error ? e.message : String(e));
      return false;
    }
  }

  function checkKey(key: string, text: string): void {
    if (key === '') throw new Refusal(t.properties.emptyKey);
    if (keysOf(text).includes(key)) throw new Refusal(t.properties.duplicate(key));
  }

  const rename = (from: string, to: string) =>
    apply((text) => {
      checkKey(to, text);
      return [{ op: 'rename', from, to }];
    });

  const set = (key: string, fn: (current: unknown) => unknown) =>
    void apply((text) => [{ op: 'set', key, value: fn(valueOf(text, key)) }]);

  const remove = (key: string) => void apply(() => [{ op: 'delete', key }]);

  async function startAdding(): Promise<void> {
    adding = true;
    await tick();
    newKey?.focus();
  }

  function commitNew(el: HTMLInputElement): void {
    const key = el.value.trim();
    if (!adding) return;
    if (key === '') {
      adding = false;
      return;
    }
    if (apply((text) => {
      checkKey(key, text);
      return [{ op: 'set', key, value: '' }];
    })) adding = false;
  }

  function newKeyDown(e: KeyboardEvent): void {
    const el = e.currentTarget as HTMLInputElement;
    if (e.key === 'Enter') {
      e.preventDefault();
      commitNew(el);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      adding = false;
    }
  }
</script>

<div class="properties">
  {#if properties.state === 'invalid'}
    <div class="notice warn" role="alert">
      <p>{t.properties.invalid}</p>
      <button type="button" class="link-button" onclick={() => note.openSource()}>{t.properties.openSource}</button>
    </div>
  {:else}
    {#if error}<p class="notice warn" role="alert">{error}</p>{/if}
    {#if properties.state === 'ok' && properties.entries.length > 0}
      {#each properties.entries as [key, value] (key)}
        <PropertyField
          name={key}
          {value}
          readonly={note.readonly}
          onRename={(to) => rename(key, to)}
          onSet={(fn) => set(key, fn)}
          onRemove={() => remove(key)}
        />
      {/each}
    {:else if !adding}
      <p class="empty">{t.properties.none}</p>
    {/if}
    {#if !note.readonly}
      {#if adding}
        <input
          bind:this={newKey}
          class="new-key"
          type="text"
          placeholder={t.properties.newKeyPlaceholder}
          aria-label={t.properties.keyLabel}
          spellcheck="false"
          onkeydown={newKeyDown}
          onblur={(e) => commitNew(e.currentTarget)}
        />
      {/if}
      <button type="button" class="link-button add" onclick={startAdding}>{t.properties.add}</button>
    {/if}
  {/if}
</div>

<style>
  .properties {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .notice,
  .empty {
    margin: 0;
    font-size: var(--font-ui-small);
    color: var(--text-muted);
  }
  .notice.warn {
    padding: var(--size-2);
    border-radius: var(--radius-s, 4px);
    background: var(--background-modifier-error-soft);
    color: var(--text-normal);
  }
  .notice p {
    margin: 0 0 var(--size-2);
  }
  .new-key {
    width: 100%;
    box-sizing: border-box;
    padding: 2px var(--size-2);
    border: 1px solid var(--background-modifier-border);
    border-radius: var(--radius-s, 4px);
    background: var(--background-primary);
    color: var(--text-normal);
    font: inherit;
    font-size: var(--font-ui-small);
  }
  .add {
    align-self: flex-start;
    margin-top: var(--size-2);
    font-size: var(--font-ui-small);
  }
</style>

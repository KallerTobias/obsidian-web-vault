<script lang="ts" module>
  export interface PaletteItem {
    id: string;
    label: string;
    /** Secondary text (folder, alias origin) shown dimmed after the label. */
    detail?: string;
    /** Shortcut, already formatted for display. */
    hotkey?: string;
  }
</script>

<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { de } from '../lib/i18n/de';

  /**
   * A modal list with a search field (quick switcher, command palette): the caller filters, this shows.
   * Arrows move, Enter chooses (Ctrl/Cmd+Enter: `newTab`), Escape or a click outside closes; focus returns
   * to where it was.
   */
  let {
    title,
    placeholder,
    query = $bindable(''),
    items,
    emptyText,
    footer,
    onSelect,
    onClose,
  }: {
    title: string;
    placeholder: string;
    query?: string;
    items: PaletteItem[];
    emptyText: string;
    /** Extra text under the list (e.g. an error). */
    footer?: string;
    onSelect: (item: PaletteItem, newTab: boolean) => void;
    onClose: () => void;
  } = $props();

  const uid = `palette-${Math.random().toString(36).slice(2, 8)}`;
  let dialog = $state<HTMLDialogElement>();
  let input = $state<HTMLInputElement>();
  let listEl = $state<HTMLUListElement>();
  let active = $state(0);
  let previousFocus: Element | null = null;

  const current = $derived(Math.min(active, items.length - 1));

  // A new query starts at the best match again.
  $effect(() => {
    void query;
    active = 0;
  });

  onMount(() => {
    previousFocus = document.activeElement;
    if (dialog) {
      // jsdom (tests) has no showModal.
      if (typeof dialog.showModal === 'function') dialog.showModal();
      else dialog.setAttribute('open', '');
    }
    input?.focus();
    input?.select();
    return () => {
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
    };
  });

  function move(delta: number): void {
    if (!items.length) return;
    active = (current + delta + items.length) % items.length;
    void tick().then(() => listEl?.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest' }));
  }

  function onkeydown(e: KeyboardEvent): void {
    if (e.isComposing) return;
    if (e.key === 'ArrowDown') move(1);
    else if (e.key === 'ArrowUp') move(-1);
    else if (e.key === 'Enter') {
      const item = items[current];
      if (item) onSelect(item, e.ctrlKey || e.metaKey);
    } else if (e.key === 'Escape') onClose();
    else return;
    e.preventDefault();
  }
</script>

<!-- A click on the backdrop is a click on the dialog itself. -->
<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
<dialog
  bind:this={dialog}
  class="palette"
  aria-label={title}
  oncancel={(e) => {
    e.preventDefault();
    onClose();
  }}
  onclick={(e) => {
    if (e.target === dialog) onClose();
  }}
>
  <input
    bind:this={input}
    bind:value={query}
    class="text-input palette-input"
    role="combobox"
    aria-expanded="true"
    aria-controls="{uid}-list"
    aria-autocomplete="list"
    aria-activedescendant={items.length ? `${uid}-${current}` : undefined}
    autocomplete="off"
    spellcheck="false"
    {placeholder}
    {onkeydown}
  />
  {#if items.length}
    <ul bind:this={listEl} id="{uid}-list" class="palette-list" role="listbox" aria-label={title}>
      {#each items as item, i (item.id)}
        <!-- Keyboard access is the combobox input's job. -->
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <li
          id="{uid}-{i}"
          role="option"
          aria-selected={i === current}
          class:active={i === current}
          onmousemove={() => (active = i)}
          onclick={(e) => onSelect(item, e.ctrlKey || e.metaKey)}
        >
          <span class="label">{item.label}</span>
          {#if item.detail}<span class="detail">{item.detail}</span>{/if}
          {#if item.hotkey}<kbd>{item.hotkey}</kbd>{/if}
        </li>
      {/each}
    </ul>
  {:else}
    <p class="empty" role="status">{emptyText}</p>
  {/if}
  {#if footer}<p class="footer error-message" role="alert">{footer}</p>{/if}
  <p class="hint">{de.palette.hint}</p>
</dialog>

<style>
  .palette {
    width: min(560px, calc(100vw - 32px));
    max-height: min(70vh, 480px);
    margin: 12vh auto auto;
    padding: var(--size-3);
    border: 1px solid var(--background-modifier-border);
    border-radius: var(--radius-l);
    background: var(--background-primary);
    color: var(--text-normal);
    box-shadow: var(--shadow-l);
    overflow: hidden;
  }
  .palette[open] {
    display: flex;
    flex-direction: column;
    gap: var(--size-2);
  }
  .palette::backdrop {
    background: var(--background-modifier-cover);
  }
  .palette-input {
    width: 100%;
    box-sizing: border-box;
  }
  .palette-list {
    flex: 1;
    min-height: 0;
    margin: 0;
    padding: 0;
    overflow: auto;
    list-style: none;
  }
  li {
    display: flex;
    align-items: baseline;
    gap: var(--size-3);
    padding: var(--size-2) var(--size-3);
    border-radius: var(--radius-s);
    cursor: pointer;
  }
  li.active {
    background: var(--text-selection);
  }
  .label {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .detail {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--text-faint);
    font-size: var(--font-ui-smaller);
  }
  kbd {
    margin-left: auto;
    color: var(--text-faint);
    font-family: inherit;
    font-size: var(--font-ui-smaller);
    white-space: nowrap;
  }
  .empty,
  .hint,
  .footer {
    margin: 0;
    padding: 0 var(--size-3);
    font-size: var(--font-ui-smaller);
    color: var(--text-faint);
  }
  .empty {
    padding: var(--size-3);
  }
</style>

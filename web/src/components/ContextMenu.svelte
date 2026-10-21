<script lang="ts" module>
  export interface MenuItem {
    label: string;
    /** Runs after the menu closed. */
    action?: () => void;
    /** A submenu: choosing the item shows these instead (with a "back" entry). */
    items?: MenuItem[];
    disabled?: boolean;
    danger?: boolean;
  }
</script>

<script lang="ts">
  import { tick } from 'svelte';
  import { de } from '../lib/i18n/de';

  /**
   * A small popup menu at (x, y) in viewport pixels. Keyboard: arrows, Home/End, Enter/Space,
   * Escape closes; a click outside or Tab closes too. The caller restores focus in `onClose`.
   */
  let { x, y, items, label, onClose }: { x: number; y: number; items: MenuItem[]; label: string; onClose: () => void } =
    $props();

  let menu = $state<HTMLDivElement>();
  /** Stack of open submenus; the last one is shown. */
  let stack = $state<MenuItem[][]>([]);
  const shown = $derived(stack.at(-1) ?? items);
  let pos = $state({ left: 0, top: 0 });

  function buttons(): HTMLButtonElement[] {
    return [...(menu?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not([disabled])') ?? [])];
  }

  async function focusFirst(): Promise<void> {
    await tick();
    buttons()[0]?.focus();
  }

  // Keep the menu inside the viewport.
  $effect(() => {
    if (!menu) return;
    const r = menu.getBoundingClientRect();
    const margin = 4;
    pos = {
      left: Math.max(margin, Math.min(x, window.innerWidth - r.width - margin)),
      top: Math.max(margin, Math.min(y, window.innerHeight - r.height - margin)),
    };
  });

  $effect(() => {
    void focusFirst();
    const outside = (e: PointerEvent) => {
      if (menu && !menu.contains(e.target as Node)) onClose();
    };
    document.addEventListener('pointerdown', outside, true);
    window.addEventListener('blur', onClose);
    window.addEventListener('resize', onClose);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      window.removeEventListener('blur', onClose);
      window.removeEventListener('resize', onClose);
    };
  });

  function choose(item: MenuItem): void {
    if (item.disabled) return;
    if (item.items) {
      stack = [...stack, item.items];
      void focusFirst();
      return;
    }
    onClose();
    item.action?.();
  }

  function back(): void {
    stack = stack.slice(0, -1);
    void focusFirst();
  }

  function onkeydown(e: KeyboardEvent): void {
    const list = buttons();
    const i = list.indexOf(document.activeElement as HTMLButtonElement);
    const focus = (j: number) => list[(j + list.length) % list.length]?.focus();
    switch (e.key) {
      case 'ArrowDown':
        focus(i + 1);
        break;
      case 'ArrowUp':
        focus(i < 0 ? -1 : i - 1);
        break;
      case 'Home':
        focus(0);
        break;
      case 'End':
        focus(-1);
        break;
      case 'ArrowLeft':
        if (stack.length) back();
        break;
      case 'Escape':
        if (stack.length) back();
        else onClose();
        break;
      case 'Tab':
        onClose();
        break;
      default:
        return;
    }
    e.preventDefault();
    e.stopPropagation();
  }
</script>

<div
  bind:this={menu}
  class="menu"
  role="menu"
  tabindex="-1"
  aria-label={label}
  style:left="{pos.left}px"
  style:top="{pos.top}px"
  {onkeydown}
  oncontextmenu={(e) => e.preventDefault()}
>
  {#if stack.length}
    <button type="button" role="menuitem" class="item back" onclick={back}>‹ {de.files.templatesBack}</button>
    <div class="separator" role="separator"></div>
  {/if}
  {#each shown as item, i (i)}
    <button
      type="button"
      role="menuitem"
      class="item"
      class:danger={item.danger}
      disabled={item.disabled}
      aria-haspopup={item.items ? 'menu' : undefined}
      onclick={() => choose(item)}
    >
      <span>{item.label}</span>
      {#if item.items}<span class="chevron" aria-hidden="true">›</span>{/if}
    </button>
  {/each}
</div>

<style>
  .menu {
    position: fixed;
    z-index: 50;
    min-width: 200px;
    max-width: min(320px, calc(100vw - 8px));
    max-height: calc(100vh - 8px);
    overflow: auto;
    padding: var(--size-2);
    background: var(--background-primary);
    border: 1px solid var(--background-modifier-border);
    border-radius: var(--radius-m);
    box-shadow: var(--shadow-l);
    font-size: var(--font-ui-small);
  }
  .item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--size-3);
    width: 100%;
    padding: 6px var(--size-3);
    border: 0;
    border-radius: var(--radius-s);
    background: transparent;
    color: var(--text-normal);
    font: inherit;
    text-align: left;
    cursor: pointer;
  }
  .item:hover:not(:disabled),
  .item:focus-visible {
    background: var(--background-modifier-hover);
  }
  .item:disabled {
    color: var(--text-faint);
    cursor: default;
  }
  .item.danger {
    color: var(--text-error);
  }
  .back {
    color: var(--text-muted);
  }
  .chevron {
    color: var(--text-faint);
  }
  .separator {
    height: 1px;
    margin: var(--size-2) 0;
    background: var(--background-modifier-border);
  }
  /* Bigger targets on touch screens. */
  @media (pointer: coarse) {
    .item {
      padding: 10px var(--size-4);
    }
  }
</style>

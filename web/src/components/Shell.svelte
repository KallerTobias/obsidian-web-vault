<script lang="ts" module>
  export const MIN_WIDTH = 160;
  export const MAX_WIDTH = 560;
  const DEFAULTS = { left: 260, right: 300 } as const;
  const KEYS = { left: 'vw.shell.left', right: 'vw.shell.right' } as const;
  const NARROW_QUERY = '(max-width: 899.98px)';
  const KEY_STEP = 16;

  type Side = 'left' | 'right';

  const clamp = (w: number) => Math.round(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, w)));

  function loadWidth(side: Side): number {
    try {
      const n = Number(localStorage.getItem(KEYS[side]));
      return Number.isFinite(n) && n > 0 ? clamp(n) : DEFAULTS[side];
    } catch {
      return DEFAULTS[side];
    }
  }

  function saveWidth(side: Side, width: number): void {
    try {
      localStorage.setItem(KEYS[side], String(width));
    } catch {
      /* storage blocked: the width just is not remembered */
    }
  }
</script>

<script lang="ts">
  import type { Snippet } from 'svelte';
  import { de } from '../lib/i18n/de';

  /**
   * Three-column layout like Obsidian: left sidebar (nav), main area, right sidebar (aside).
   * Wide: sidebars are columns with draggable splitters; narrow (< 900 px): overlays opened from the header.
   */
  let {
    left,
    main,
    right,
    toolbar,
    title = de.appName,
  }: { left: Snippet; main: Snippet; right: Snippet; toolbar?: Snippet; title?: string } = $props();

  let widths = $state({ left: loadWidth('left'), right: loadWidth('right') });
  /** Wide layout: which sidebars are shown as columns. */
  let docked = $state({ left: true, right: true });
  /** Narrow layout: the sidebar currently shown as overlay. */
  let overlay = $state<Side | null>(null);
  let narrow = $state(window.matchMedia(NARROW_QUERY).matches);
  let dragging = $state<Side | null>(null);

  const toggles: Record<Side, HTMLButtonElement | undefined> = { left: undefined, right: undefined };
  const panels: Record<Side, HTMLElement | undefined> = { left: undefined, right: undefined };

  $effect(() => {
    const media = window.matchMedia(NARROW_QUERY);
    const update = () => {
      narrow = media.matches;
      overlay = null;
    };
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  });

  const isOpen = (side: Side) => (narrow ? overlay === side : docked[side]);

  function toggle(side: Side): void {
    if (!narrow) {
      docked[side] = !docked[side];
      return;
    }
    overlay = overlay === side ? null : side;
    if (overlay) queueMicrotask(() => panels[side]?.focus());
  }

  /** Shows a sidebar (e.g. when a shortcut needs it) and, in the narrow layout, focuses it. */
  export function openSide(side: Side): void {
    if (isOpen(side)) return;
    toggle(side);
  }

  function closeOverlay(): void {
    const side = overlay;
    overlay = null;
    if (side) toggles[side]?.focus();
  }

  function onKeydown(e: KeyboardEvent): void {
    if (e.key === 'Escape' && narrow && overlay) {
      e.preventDefault();
      closeOverlay();
    }
  }

  // --- Splitters ---

  let dragStart = { x: 0, width: 0 };

  function setWidth(side: Side, width: number, persist: boolean): void {
    widths[side] = clamp(width);
    if (persist) saveWidth(side, widths[side]);
  }

  function onPointerDown(side: Side, e: PointerEvent): void {
    if (e.button !== 0) return;
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    dragStart = { x: e.clientX, width: widths[side] };
    dragging = side;
  }

  function onPointerMove(side: Side, e: PointerEvent): void {
    if (dragging !== side) return;
    const dx = e.clientX - dragStart.x;
    setWidth(side, dragStart.width + (side === 'left' ? dx : -dx), false);
  }

  function onPointerEnd(side: Side): void {
    if (dragging !== side) return;
    dragging = null;
    saveWidth(side, widths[side]);
  }

  function onSplitterKey(side: Side, e: KeyboardEvent): void {
    // Arrow direction = direction the splitter moves.
    const grow = side === 'left' ? 1 : -1;
    const delta: Record<string, number> = { ArrowLeft: -KEY_STEP * grow, ArrowRight: KEY_STEP * grow };
    if (e.key in delta) setWidth(side, widths[side] + delta[e.key]!, true);
    else if (e.key === 'Home') setWidth(side, MIN_WIDTH, true);
    else if (e.key === 'End') setWidth(side, MAX_WIDTH, true);
    else return;
    e.preventDefault();
  }

  function resetWidth(side: Side): void {
    setWidth(side, DEFAULTS[side], true);
  }
</script>

<svelte:window onkeydown={onKeydown} />

<!-- A focusable separator is an interactive ARIA widget (window splitter pattern). -->
{#snippet splitter(side: Side)}
  <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
  <div
    class="splitter splitter-{side}"
    class:active={dragging === side}
    role="separator"
    aria-orientation="vertical"
    aria-label={side === 'left' ? de.shell.resizeLeft : de.shell.resizeRight}
    aria-controls="shell-{side}"
    aria-valuenow={widths[side]}
    aria-valuemin={MIN_WIDTH}
    aria-valuemax={MAX_WIDTH}
    tabindex="0"
    onpointerdown={(e) => onPointerDown(side, e)}
    onpointermove={(e) => onPointerMove(side, e)}
    onlostpointercapture={() => onPointerEnd(side)}
    onkeydown={(e) => onSplitterKey(side, e)}
    ondblclick={() => resetWidth(side)}
  ></div>
{/snippet}

<div
  class="shell"
  class:narrow
  class:dragging={dragging !== null}
  style:--left-width="{widths.left}px"
  style:--right-width="{widths.right}px"
>
  <header class="titlebar">
    <button
      bind:this={toggles.left}
      type="button"
      class="icon-button"
      aria-label={de.shell.toggleLeft}
      aria-controls="shell-left"
      aria-expanded={isOpen('left')}
      onclick={() => toggle('left')}
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <rect x="3" y="3" width="18" height="18" rx="2" /><path d="M9 3v18" />
      </svg>
    </button>
    <span class="title">{title}</span>
    <div class="toolbar">{@render toolbar?.()}</div>
    <button
      bind:this={toggles.right}
      type="button"
      class="icon-button"
      aria-label={de.shell.toggleRight}
      aria-controls="shell-right"
      aria-expanded={isOpen('right')}
      onclick={() => toggle('right')}
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <rect x="3" y="3" width="18" height="18" rx="2" /><path d="M15 3v18" />
      </svg>
    </button>
  </header>

  <div class="columns" class:left-docked={!narrow && docked.left} class:right-docked={!narrow && docked.right}>
    <nav
      id="shell-left"
      bind:this={panels.left}
      class="side side-left"
      class:overlay={narrow}
      aria-label={de.shell.leftSidebar}
      tabindex="-1"
      hidden={!isOpen('left')}
      inert={narrow && overlay === 'right'}
    >
      {@render left()}
    </nav>

    {#if !narrow && docked.left}{@render splitter('left')}{/if}

    <main class="main" aria-label={de.shell.main} inert={narrow && overlay !== null}>
      {@render main()}
    </main>

    {#if !narrow && docked.right}{@render splitter('right')}{/if}

    <aside
      id="shell-right"
      bind:this={panels.right}
      class="side side-right"
      class:overlay={narrow}
      aria-label={de.shell.rightSidebar}
      tabindex="-1"
      hidden={!isOpen('right')}
      inert={narrow && overlay === 'left'}
    >
      {@render right()}
    </aside>

    {#if narrow && overlay}
      <button type="button" class="backdrop" aria-label={de.shell.closeOverlay} onclick={closeOverlay}></button>
    {/if}
  </div>
</div>

<style>
  .shell {
    display: flex;
    flex-direction: column;
    height: 100%;
    background: var(--background-primary);
  }
  .shell.dragging {
    cursor: col-resize;
    -webkit-user-select: none;
    user-select: none;
  }

  .titlebar {
    display: flex;
    align-items: center;
    gap: var(--size-3);
    height: var(--header-height);
    flex: none;
    padding: 0 var(--size-3);
    border-bottom: 1px solid var(--background-modifier-border);
    background: var(--background-secondary);
  }
  .title {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: var(--font-ui-small);
    font-weight: 600;
    color: var(--text-muted);
  }
  .toolbar {
    display: flex;
    align-items: center;
    gap: 2px;
  }

  .columns {
    position: relative;
    flex: 1;
    min-height: 0;
    display: grid;
    grid-template-columns: 0 0 minmax(0, 1fr) 0 0;
  }
  .columns.left-docked {
    grid-template-columns: var(--left-width) 0 minmax(0, 1fr) 0 0;
  }
  .columns.right-docked {
    grid-template-columns: 0 0 minmax(0, 1fr) 0 var(--right-width);
  }
  .columns.left-docked.right-docked {
    grid-template-columns: var(--left-width) 0 minmax(0, 1fr) 0 var(--right-width);
  }
  .side-left {
    grid-column: 1;
  }
  .splitter-left {
    grid-column: 2;
  }
  .main {
    grid-column: 3;
  }
  .splitter-right {
    grid-column: 4;
  }
  .side-right {
    grid-column: 5;
  }

  .side {
    grid-row: 1;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
    background: var(--background-secondary);
  }
  .side:focus-visible {
    outline-offset: -2px;
  }
  .side-left {
    border-right: 1px solid var(--background-modifier-border);
  }
  .side-right {
    border-left: 1px solid var(--background-modifier-border);
  }
  .side[hidden] {
    display: none;
  }

  .main {
    grid-row: 1;
    min-width: 0;
    min-height: 0;
    overflow: auto;
    background: var(--background-primary);
  }

  /* Zero-width grid track; the hit area overlaps both neighbours. */
  .splitter {
    grid-row: 1;
    position: relative;
    z-index: 2;
    width: 0;
    cursor: col-resize;
    touch-action: none;
    -webkit-user-select: none;
    user-select: none;
  }
  .splitter::before {
    content: '';
    position: absolute;
    inset: 0 calc(var(--splitter-hit) / -2);
  }
  .splitter::after {
    content: '';
    position: absolute;
    inset: 0 -1px;
    background: transparent;
    transition: background-color 120ms;
  }
  .splitter:hover::after,
  .splitter.active::after,
  .splitter:focus-visible::after {
    background: var(--interactive-accent);
  }
  .splitter:focus-visible {
    outline: none;
  }

  /* Narrow: sidebars float above the main area. */
  .side.overlay {
    position: absolute;
    z-index: 10;
    inset-block: 0;
    width: min(85vw, var(--left-width));
    box-shadow: var(--shadow-l);
    animation: slide-in-left 150ms ease-out;
  }
  .side-left.overlay {
    left: 0;
  }
  .side-right.overlay {
    right: 0;
    width: min(85vw, var(--right-width));
    animation-name: slide-in-right;
  }
  .backdrop {
    position: absolute;
    z-index: 9;
    inset: 0;
    border: 0;
    padding: 0;
    background: var(--background-modifier-cover);
    cursor: default;
  }
  .shell.narrow .main {
    grid-column: 1 / -1;
  }

  @keyframes slide-in-left {
    from {
      transform: translateX(-100%);
    }
  }
  @keyframes slide-in-right {
    from {
      transform: translateX(100%);
    }
  }
</style>

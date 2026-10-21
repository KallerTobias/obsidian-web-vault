<script lang="ts" module>
  /** Fixed row height: the list is virtualised (only rows in view are rendered). */
  export const ROW_HEIGHT = 26;
  const OVERSCAN = 12;
  const EXPANDED_KEY = 'vw.tree.expanded';
  const LONG_PRESS_MS = 500;
  const LONG_PRESS_SLOP = 10;

  function loadExpanded(): Set<string> {
    try {
      const v: unknown = JSON.parse(localStorage.getItem(EXPANDED_KEY) ?? '[]');
      return new Set(Array.isArray(v) ? v.filter((p): p is string => typeof p === 'string') : []);
    } catch {
      return new Set();
    }
  }

  function saveExpanded(set: Set<string>): void {
    try {
      localStorage.setItem(EXPANDED_KEY, JSON.stringify([...set]));
    } catch {
      /* storage blocked: folders just are not remembered */
    }
  }
</script>

<script lang="ts">
  import { dirname, joinPath } from '@shared/normalize';
  import { ApiError, api, type RenameResult, type TreeEntry } from '../lib/api';
  import { de } from '../lib/i18n/de';
  import {
    displayName,
    findEntry,
    folderPaths,
    isAtOrBelow,
    movePath,
    uniqueChildName,
    visibleRows,
  } from '../lib/tree';
  import ContextMenu, { type MenuItem } from './ContextMenu.svelte';
  import RenameDialog from './RenameDialog.svelte';
  import TemplatePicker from './TemplatePicker.svelte';
  import TreeNode from './TreeNode.svelte';

  /**
   * The vault as a tree: `role="tree"` with aria-activedescendant (focus stays on the tree, so rows
   * can be virtualised). Arrows/Home/End move, Right/Left open/close folders, Enter opens,
   * Ctrl/Cmd+Enter or Ctrl/Cmd-click or middle click opens in a new tab, F2 renames, Delete trashes,
   * Shift+F10/context-menu key or right click/long press opens the context menu. Drag & drop moves.
   */
  let {
    root,
    currentPath,
    onOpen,
    onRenamed,
    onTrashed,
    onChanged,
  }: {
    root: TreeEntry;
    /** The file shown in the active tab (highlighted). */
    currentPath?: string;
    onOpen: (path: string, opts: { newTab: boolean }) => void;
    onRenamed?: (from: string, to: string) => void;
    onTrashed?: (path: string) => void;
    /** Something changed on the server: reload the tree now instead of waiting for the event. */
    onChanged?: () => void;
  } = $props();

  const uid = `tree-${Math.random().toString(36).slice(2, 8)}`;
  const rowId = (i: number) => `${uid}-r${i}`;

  let treeEl = $state<HTMLDivElement>();
  let expanded = $state.raw(loadExpanded());
  let scrollTop = $state(0);
  let viewHeight = $state(0);
  /** Keyboard cursor, by path so it survives reloads of the tree. */
  let cursorPath = $state<string | null>(null);
  /** Show the cursor only while the keyboard is in use. */
  let keyboard = $state(false);
  let menu = $state<{ x: number; y: number; entry: TreeEntry; items: MenuItem[] } | null>(null);
  let dialog = $state<{ path: string; kind: TreeEntry['kind']; mode: 'rename' | 'move'; target?: string } | null>(null);
  let picker = $state<{ folder: string } | null>(null);
  let dragPath = $state<string | null>(null);
  let dropFolder = $state<string | null>(null);
  let actionError = $state('');

  const rows = $derived(visibleRows(root, expanded));
  const cursor = $derived(cursorPath === null ? -1 : rows.findIndex((r) => r.entry.path === cursorPath));
  // jsdom and the first paint have no height yet: render a screenful anyway.
  const first = $derived(Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN));
  const last = $derived(Math.min(rows.length, Math.ceil((scrollTop + (viewHeight || 800)) / ROW_HEIGHT) + OVERSCAN));
  const windowRows = $derived(rows.slice(first, last));

  function setExpanded(next: Set<string>): void {
    expanded = next;
    saveExpanded(next);
  }

  function toggle(path: string, open = !expanded.has(path)): void {
    if (open === expanded.has(path)) return;
    const next = new Set(expanded);
    if (open) next.add(path);
    else next.delete(path);
    setExpanded(next);
  }

  /** Opens `path` and every folder above it. */
  function expandTo(path: string): void {
    const next = new Set(expanded);
    for (let p = path; p !== ''; p = dirname(p)) next.add(p);
    setExpanded(next);
  }

  function rowAt(e: Event): number {
    const el = (e.target as Element | null)?.closest?.('[data-index]');
    return el ? Number(el.getAttribute('data-index')) : -1;
  }

  function moveCursor(i: number): void {
    const row = rows[Math.max(0, Math.min(rows.length - 1, i))];
    if (!row) return;
    cursorPath = row.entry.path;
    const index = rows.indexOf(row);
    // Scroll the row into view (it may not be rendered yet).
    if (treeEl) {
      const top = index * ROW_HEIGHT;
      const height = treeEl.clientHeight || viewHeight;
      if (top < treeEl.scrollTop) treeEl.scrollTop = top;
      else if (height && top + ROW_HEIGHT > treeEl.scrollTop + height) treeEl.scrollTop = top + ROW_HEIGHT - height;
      scrollTop = treeEl.scrollTop;
    }
  }

  function activate(entry: TreeEntry, newTab: boolean): void {
    if (entry.kind === 'folder') toggle(entry.path);
    else onOpen(entry.path, { newTab });
  }

  // --- input ---

  function onclick(e: MouseEvent): void {
    if (longPressed) {
      longPressed = false;
      return;
    }
    const i = rowAt(e);
    const row = rows[i];
    if (!row) return;
    cursorPath = row.entry.path;
    activate(row.entry, e.ctrlKey || e.metaKey);
  }

  function onauxclick(e: MouseEvent): void {
    const row = rows[rowAt(e)];
    if (e.button !== 1 || !row || row.entry.kind === 'folder') return;
    e.preventDefault();
    cursorPath = row.entry.path;
    onOpen(row.entry.path, { newTab: true });
  }

  function onkeydown(e: KeyboardEvent): void {
    keyboard = true;
    const row = rows[cursor];
    if ((e.key === 'F10' && e.shiftKey) || e.key === 'ContextMenu') {
      e.preventDefault();
      const target = row?.entry ?? root;
      const el = row ? document.getElementById(rowId(cursor)) : treeEl;
      const r = el?.getBoundingClientRect();
      void openMenu(target, (r?.left ?? 0) + 24, r?.bottom ?? 0);
      return;
    }
    switch (e.key) {
      case 'ArrowDown':
        moveCursor(cursor + 1);
        break;
      case 'ArrowUp':
        moveCursor(cursor < 0 ? 0 : cursor - 1);
        break;
      case 'Home':
        moveCursor(0);
        break;
      case 'End':
        moveCursor(rows.length - 1);
        break;
      case 'ArrowRight':
        if (!row || row.entry.kind !== 'folder') return;
        if (!row.expanded) toggle(row.entry.path, true);
        else if (rows[cursor + 1]?.parent === cursor) moveCursor(cursor + 1);
        break;
      case 'ArrowLeft':
        if (!row) return;
        if (row.expanded) toggle(row.entry.path, false);
        else if (row.parent >= 0) moveCursor(row.parent);
        break;
      case 'Enter':
        if (!row) return;
        activate(row.entry, e.ctrlKey || e.metaKey);
        break;
      case 'F2':
        if (!row || row.entry.readonly) return;
        dialog = { path: row.entry.path, kind: row.entry.kind, mode: 'rename' };
        break;
      case 'Delete':
        if (!row || row.entry.readonly) return;
        void trash(row.entry);
        break;
      default:
        return;
    }
    e.preventDefault();
  }

  function onfocus(): void {
    if (cursor >= 0 || !rows.length) return;
    const i = currentPath ? rows.findIndex((r) => r.entry.path === currentPath) : -1;
    cursorPath = rows[Math.max(0, i)]!.entry.path;
  }

  function oncontextmenu(e: MouseEvent): void {
    e.preventDefault();
    const row = rows[rowAt(e)];
    if (row) cursorPath = row.entry.path;
    void openMenu(row?.entry ?? root, e.clientX, e.clientY);
  }

  // Long press (touch): iOS fires no contextmenu event; on Android whichever comes first wins.
  let pressTimer: ReturnType<typeof setTimeout> | undefined;
  let pressStart = { x: 0, y: 0 };
  let longPressed = false;

  function onpointerdown(e: PointerEvent): void {
    keyboard = false;
    longPressed = false;
    if (e.pointerType !== 'touch') return;
    clearTimeout(pressTimer);
    pressStart = { x: e.clientX, y: e.clientY };
    const row = rows[rowAt(e)];
    pressTimer = setTimeout(() => {
      longPressed = true;
      if (row) cursorPath = row.entry.path;
      void openMenu(row?.entry ?? root, pressStart.x, pressStart.y);
    }, LONG_PRESS_MS);
  }

  function onpointermove(e: PointerEvent): void {
    if (pressTimer === undefined) return;
    if (Math.hypot(e.clientX - pressStart.x, e.clientY - pressStart.y) > LONG_PRESS_SLOP) cancelPress();
  }

  function cancelPress(): void {
    clearTimeout(pressTimer);
    pressTimer = undefined;
  }

  // --- drag & drop (= move, with the same question about links) ---

  /** Folder a drop on this row goes into: the folder itself, or the folder of a file. */
  function dropTargetFor(e: DragEvent): string | null {
    const row = rows[rowAt(e)];
    const folder = row ? (row.entry.kind === 'folder' ? row.entry.path : dirname(row.entry.path)) : '';
    if (dragPath === null || folder === dirname(dragPath) || isAtOrBelow(folder, dragPath)) return null;
    if (findEntry(root, folder)?.readonly) return null;
    return folder;
  }

  function ondragstart(e: DragEvent): void {
    const row = rows[rowAt(e)];
    if (!row || row.entry.readonly) {
      e.preventDefault();
      return;
    }
    cancelPress();
    dragPath = row.entry.path;
    e.dataTransfer?.setData('text/plain', row.entry.path);
    if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
  }

  function ondragover(e: DragEvent): void {
    const folder = dropTargetFor(e);
    dropFolder = folder;
    if (folder === null) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
  }

  function ondrop(e: DragEvent): void {
    const folder = dropTargetFor(e);
    const from = dragPath;
    endDrag();
    if (folder === null || from === null) return;
    e.preventDefault();
    const entry = findEntry(root, from);
    if (entry) dialog = { path: from, kind: entry.kind, mode: 'move', target: folder };
  }

  function endDrag(): void {
    dragPath = null;
    dropFolder = null;
  }

  // --- actions ---

  function closeMenu(): void {
    menu = null;
    treeEl?.focus();
  }

  function closeDialog(): void {
    dialog = null;
    treeEl?.focus();
  }

  function fail(err: unknown): void {
    actionError = de.files.actionFailed(err instanceof Error ? err.message : String(err));
  }

  /** Set while the menu is being prepared (templates load): a second trigger must not open another. */
  let menuPending = false;

  async function openMenu(entry: TreeEntry, x: number, y: number): Promise<void> {
    if (menu || menuPending) return;
    menuPending = true;
    actionError = '';
    const folder = entry.kind === 'folder' ? entry.path : dirname(entry.path);
    const folderReadonly = findEntry(root, folder)?.readonly ?? false;
    const isRoot = entry.path === '';
    const items: MenuItem[] = [
      { label: de.files.newNote, action: () => void newNote(folder), disabled: folderReadonly },
      { label: de.files.newNoteFromTemplate, action: () => (picker = { folder }), disabled: folderReadonly },
      { label: de.files.newFolder, action: () => void newFolder(folder), disabled: folderReadonly },
    ];
    if (!isRoot) {
      items.push(
        { label: de.files.rename, disabled: entry.readonly, action: () => (dialog = { path: entry.path, kind: entry.kind, mode: 'rename' }) },
        { label: de.files.move, disabled: entry.readonly, action: () => (dialog = { path: entry.path, kind: entry.kind, mode: 'move' }) },
        { label: de.files.delete, disabled: entry.readonly, danger: true, action: () => void trash(entry) },
      );
    }
    menu = { x, y, entry, items };
    menuPending = false;
  }

  /** Creates `stem.ext` (or `stem 1.ext` …) in `folder`; on a name clash with an entry the tree does not know yet, tries the next. */
  async function createUnique(folder: string, stem: string, ext: string, create: (path: string) => Promise<unknown>): Promise<string> {
    const parent = findEntry(root, folder);
    const taken: TreeEntry[] = [...(parent?.children ?? [])];
    for (let attempt = 0; ; attempt++) {
      const name = uniqueChildName({ ...root, children: taken }, stem, ext);
      const path = joinPath(folder, name);
      try {
        await create(path);
        return path;
      } catch (err) {
        if (!(err instanceof ApiError && err.status === 409) || attempt >= 20) throw err;
        taken.push({ ...root, path, name, kind: 'file', children: undefined });
      }
    }
  }

  async function newNote(folder: string): Promise<void> {
    try {
      const path = await createUnique(folder, de.files.untitled, '.md', (p) => api.note.create(p, ''));
      if (folder) expandTo(folder);
      cursorPath = path;
      onChanged?.();
      onOpen(path, { newTab: false });
    } catch (err) {
      fail(err);
    }
  }

  async function newFolder(folder: string): Promise<void> {
    try {
      const path = await createUnique(folder, de.files.untitledFolder, '', (p) => api.folder.create(p));
      if (folder) expandTo(folder);
      cursorPath = path;
      onChanged?.();
      dialog = { path, kind: 'folder', mode: 'rename' };
    } catch (err) {
      fail(err);
    }
  }

  async function trash(entry: TreeEntry): Promise<void> {
    actionError = '';
    if (!confirm(`${displayName(entry)}\n\n${de.files.trashConfirm}`)) return;
    try {
      await api.entry.trash(entry.path);
      onTrashed?.(entry.path);
      onChanged?.();
    } catch (err) {
      fail(err);
    }
    treeEl?.focus();
  }

  function renamed(from: string, to: string, _result: RenameResult): void {
    // Open folders and the cursor follow the move.
    setExpanded(new Set([...expanded].map((p) => movePath(p, from, to))));
    if (dirname(to)) expandTo(dirname(to));
    if (cursorPath !== null) cursorPath = movePath(cursorPath, from, to);
    onRenamed?.(from, to);
    onChanged?.();
  }

  /** Collapses every folder (toolbar). */
  export function collapseAll(): void {
    setExpanded(new Set());
  }

  /** New note in the folder the settings name (toolbar). */
  export async function newNoteInDefaultFolder(): Promise<void> {
    await newNote(await newNoteFolder());
  }

  /** The folder the settings name for new notes, if it exists; else the vault root. */
  async function newNoteFolder(): Promise<string> {
    const settings = await api.settings.get().catch(() => null);
    const dir = (settings?.newNoteFolder ?? '').replace(/^\/+|\/+$/g, '');
    return findEntry(root, dir)?.kind === 'folder' ? dir : '';
  }

  /** Opens the template picker for a new note in the folder for new notes (command palette). */
  export async function newNoteFromTemplate(): Promise<void> {
    if (picker) return;
    picker = { folder: await newNoteFolder() };
  }

  /** A template note was created: show it like any new note. */
  function templateCreated(path: string): void {
    const folder = dirname(path);
    if (folder) expandTo(folder);
    cursorPath = path;
    onChanged?.();
    onOpen(path, { newTab: false });
  }

  function closePicker(): void {
    picker = null;
    treeEl?.focus();
  }

  /** Rename dialog for `path` (command palette). */
  export function renamePath(path: string): void {
    const entry = findEntry(root, path);
    if (entry && !entry.readonly) dialog = { path, kind: entry.kind, mode: 'rename' };
  }

  /** Trashes `path` after the usual confirmation (command palette). */
  export async function trashPath(path: string): Promise<void> {
    const entry = findEntry(root, path);
    if (entry && !entry.readonly) await trash(entry);
  }

  export async function newFolderInRoot(): Promise<void> {
    await newFolder('');
  }
</script>

<div class="file-tree">
  {#if actionError}
    <p class="error-message" role="alert">{actionError}</p>
  {/if}
  {#if rows.length === 0}
    <p class="empty">{de.files.empty}</p>
  {/if}
  <div
    bind:this={treeEl}
    bind:clientHeight={viewHeight}
    class="tree"
    role="tree"
    tabindex="0"
    aria-label={de.files.treeLabel}
    aria-activedescendant={cursor >= first && cursor < last ? rowId(cursor) : undefined}
    onscroll={() => (scrollTop = treeEl?.scrollTop ?? 0)}
    {onclick}
    {onauxclick}
    onmousedown={(e) => {
      if (e.button === 1) e.preventDefault(); // no autoscroll on middle click
    }}
    {onkeydown}
    {onfocus}
    {oncontextmenu}
    {onpointerdown}
    {onpointermove}
    onpointerup={cancelPress}
    onpointercancel={cancelPress}
    {ondragstart}
    {ondragover}
    ondragleave={(e) => {
      if (!treeEl?.contains(e.relatedTarget as Node | null)) dropFolder = null;
    }}
    {ondrop}
    ondragend={endDrag}
    class:drop-root={dropFolder === ''}
    style:--tree-row-height="{ROW_HEIGHT}px"
  >
    <div class="spacer" style:height="{rows.length * ROW_HEIGHT}px">
      {#each windowRows as row, k (row.entry.path)}
        <TreeNode
          {row}
          index={first + k}
          id={rowId(first + k)}
          top={(first + k) * ROW_HEIGHT}
          cursor={keyboard && first + k === cursor}
          current={row.entry.path === currentPath}
          dropTarget={dropFolder !== null && dropFolder !== '' && row.entry.path === dropFolder}
        />
      {/each}
    </div>
  </div>
</div>

{#if menu}
  <ContextMenu x={menu.x} y={menu.y} items={menu.items} label={de.files.menuFor(displayName(menu.entry) || de.appName)} onClose={closeMenu} />
{/if}

{#if picker}
  <TemplatePicker folder={picker.folder} onCreated={templateCreated} onClose={closePicker} />
{/if}

{#if dialog}
  <RenameDialog
    path={dialog.path}
    kind={dialog.kind}
    mode={dialog.mode}
    target={dialog.target}
    folders={dialog.mode === 'move' ? folderPaths(root) : []}
    onDone={renamed}
    onClose={closeDialog}
  />
{/if}

<style>
  .file-tree {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    --tree-indent: 14px;
  }
  .tree {
    position: relative;
    flex: 1;
    min-height: 0;
    overflow: auto;
    border-radius: var(--radius-s);
    outline-offset: -2px;
  }
  .tree.drop-root {
    background: var(--text-selection);
  }
  .spacer {
    position: relative;
    min-height: 100%;
  }
  .empty {
    color: var(--text-faint);
    padding: var(--size-3);
  }
  .error-message {
    margin: 0 0 var(--size-3);
  }
</style>

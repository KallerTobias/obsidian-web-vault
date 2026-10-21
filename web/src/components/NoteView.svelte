<script lang="ts">
  import type { FileLookup } from '@shared/resolve';
  import { onDestroy, onMount, tick } from 'svelte';
  import { api, ApiError } from '../lib/api';
  import { attachmentLinkText } from '../lib/editor/paste';
  import { draftStorage, NoteSaver, type Conflict, type SaverState } from '../lib/editor/save';
  import type { EditorHandle } from '../lib/editor/setup';
  import { EditorSelection } from '@codemirror/state';
  import { EditorView } from '@codemirror/view';
  import { activeNote, type ActiveNote } from '../lib/stores/active-note';
  import { taskToggle } from '../lib/editor/tasks';
  import { de } from '../lib/i18n/de';
  import { events } from '../lib/stores/events';
  import { editorSettings } from '../lib/stores/settings';
  import { vault } from '../lib/stores/vault';
  import { get } from 'svelte/store';
  import { session } from '../lib/stores/session';
  import ConflictDialog from './ConflictDialog.svelte';
  import ModeSwitch, { type ViewMode } from './ModeSwitch.svelte';
  import ReadingView, { type OpenLinkOptions } from './ReadingView.svelte';

  /**
   * One open note: editor (Bearbeiten/Quelltext) or reading view, saved automatically. Shows the save
   * state, conflicts (dialog), drafts kept while offline, read-only and deleted-on-disk notices.
   * Mounted once per path; the mode always starts at Bearbeiten.
   */
  let {
    path,
    subpath,
    reveal,
    deleted = false,
    lookup,
    onOpenLink,
    onTag,
    onCloseTab,
  }: {
    path: string;
    subpath?: string;
    /** 0-based line to scroll to (a new object for every navigation). */
    reveal?: { line: number };
    /** The workspace marked the tab deleted (the file or a folder above it was removed). */
    deleted?: boolean;
    lookup: FileLookup;
    onOpenLink?: (target: string, opts: OpenLinkOptions) => void;
    /** A tag was clicked (reading view or live preview); the tag without `#`. */
    onTag?: (tag: string) => void;
    onCloseTab?: () => void;
  } = $props();

  let loadState = $state<'loading' | 'error' | 'notUtf8' | 'ready'>('loading');
  let mode = $state<ViewMode>('live');
  /** The editor's text (also rendered by the reading view). */
  let text = $state('');
  let readonly = $state(false);
  let saveState = $state<SaverState>('saved');
  let conflict = $state<Conflict | null>(null);
  let goneOnDisk = $state(false);
  let unsaved = $state(false);
  let errorMessage = $state('');
  let draftRestored = $state(false);
  let editorHost = $state<HTMLDivElement>();
  /** An upload problem (too large, failed), shown until dismissed. */
  let uploadError = $state('');
  let readingView = $state<ReadingView>();
  /** The editor exists (it is created after the first render). */
  let editorReady = $state(false);
  /** Tags of the vault for `#` completion, most used first. */
  let tagNames: string[] = [];

  let saver: NoteSaver | undefined;
  let editor: EditorHandle | undefined;
  let destroyed = false;
  const cleanups: (() => void)[] = [];

  function sync(): void {
    if (!saver) return;
    saveState = saver.state;
    conflict = saver.conflict;
    goneOnDisk = saver.deleted;
    unsaved = saver.unsaved;
    errorMessage = saver.errorMessage;
    if (saveState === 'saved') draftRestored = false;
  }

  async function load(): Promise<void> {
    loadState = 'loading';
    let note: Awaited<ReturnType<typeof api.note.get>>;
    let createEditor: typeof import('../lib/editor/setup').createEditor;
    try {
      // CodeMirror is its own chunk: the app shell loads without it.
      [note, { createEditor }] = await Promise.all([api.note.get(path), import('../lib/editor/setup')]);
    } catch (err) {
      // 415: not UTF-8 – editing would re-encode it, so only a download is offered.
      if (!destroyed) loadState = err instanceof ApiError && err.status === 415 ? 'notUtf8' : 'error';
      return;
    }
    if (destroyed) return;
    readonly = note.readonly;
    const s = new NoteSaver(path, note.version, api.note, draftStorage(), {
      content: note.content,
      readonly: note.readonly,
      onReload: (content) => {
        text = content;
        editor?.replaceDoc(content, true);
      },
      onUpdate: sync,
    });
    saver = s;
    draftRestored = s.restoreDraft() === 'restored';
    text = s.text;
    sync();
    loadState = 'ready';
    await tick();
    if (destroyed || !editorHost) return;
    editor = createEditor(editorHost, {
      doc: s.text,
      mode: mode === 'source' ? 'source' : 'live',
      readonly: note.readonly,
      path,
      lookup: () => lookup,
      openLink: (target, sub, newTab, unresolved) => onOpenLink?.(target, { subpath: sub, newTab, unresolved }),
      openTag: (tag) => onTag?.(tag),
      loadNote: async (p) => (await api.note.get(p)).content,
      completion: {
        links: () => ({ entries: get(vault.lookup), files: lookup, format: get(editorSettings).newLinkFormat }),
        tags: () => tagNames,
      },
      attachments: {
        upload: (file, pasted) => api.attachment.upload(file, { notePath: path, pasted }),
        linkText: (p) => attachmentLinkText(p, path, lookup, get(editorSettings).newLinkFormat),
        onError: (message) => {
          uploadError = message;
        },
      },
      onChange: (doc) => {
        text = doc;
        s.edit(doc);
        sync();
      },
    });
    editorReady = true;
    if (deleted) s.markDeleted();

    cleanups.push(
      events.onNoteChanged(path, (e) => {
        if (e.type === 'deleted') s.markDeleted();
        else if (e.type !== 'renamed' && e.version) void s.onExternalChange(e.version).then(sync);
      }),
    );
    // Back online or logged in again: save what is waiting.
    let wasExpired = false;
    cleanups.push(
      session.expired.subscribe((expired) => {
        if (wasExpired && !expired && s.state === 'offline') void s.flush();
        wasExpired = expired;
      }),
    );
    const online = () => {
      if (s.state === 'offline') void s.flush();
    };
    window.addEventListener('online', online);
    cleanups.push(() => window.removeEventListener('online', online));
  }

  // Files were added, renamed or removed: the editor's rendered links resolve again.
  $effect(() => {
    void lookup;
    editor?.refreshLinks();
    // Tags change together with the notes; the lookup is reloaded (debounced) after every save.
    api.tags().then(
      (list) => {
        tagNames = list.sort((a, b) => b.count - a.count).map((t) => t.tag);
      },
      () => {},
    );
  });

  // A folder above the note was deleted (no event for the note itself).
  $effect(() => {
    if (deleted) saver?.markDeleted();
  });

  /** Replaces the text with a programmatic change (no userEvent: the frontmatter guard lets it through). */
  function editText(fn: (text: string) => string): void {
    if (readonly || !editor) return;
    const doc = editor.view.state.sliceDoc();
    const next = fn(doc);
    if (doc === next) return;
    let from = 0;
    while (from < doc.length && from < next.length && doc.charCodeAt(from) === next.charCodeAt(from)) from++;
    let end = 0;
    while (end < doc.length - from && end < next.length - from && doc.charCodeAt(doc.length - 1 - end) === next.charCodeAt(next.length - 1 - end)) end++;
    editor.view.dispatch({ changes: { from, to: doc.length - end, insert: next.slice(from, next.length - end) } });
  }

  function revealLine(line: number, focus = false): void {
    if (!editor) return;
    const doc = editor.view.state.doc;
    if (!Number.isInteger(line) || line < 0) return;
    const pos = doc.line(Math.min(line, doc.lines - 1) + 1).from;
    editor.view.dispatch({ selection: EditorSelection.cursor(pos), effects: EditorView.scrollIntoView(pos, { y: 'start', yMargin: 24 }) });
    if (focus && mode !== 'reading') editor.view.focus();
  }

  function revealHeading(h: { line: number; text: string }): void {
    if (mode === 'reading') readingView?.scrollToSubpath(h.text);
    else revealLine(h.line, true);
  }

  // Backlinks and search open the note at a line.
  $effect(() => {
    if (editorReady && reveal) revealLine(reveal.line);
  });

  // The right panel follows this note (only the active tab's note is mounted).
  let published: ActiveNote | null = null;
  $effect(() => {
    if (!editorReady) return;
    const current: ActiveNote = {
      path,
      text,
      readonly,
      mode,
      edit: editText,
      revealLine: (line) => revealLine(line, true),
      revealHeading,
      openSource: () => setMode('source'),
      setMode,
    };
    published = current;
    activeNote.set(current);
  });

  function setMode(m: ViewMode): void {
    mode = m;
    if (m !== 'reading') {
      editor?.setMode(m);
      void tick().then(() => editor?.view.focus());
    }
  }

  function onKeydown(e: KeyboardEvent): void {
    if (e.defaultPrevented || loadState !== 'ready') return;
    // Not underneath a modal (conflict, rename, login …).
    if (document.querySelector('dialog[open]')) return;
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'e') {
      e.preventDefault();
      setMode(mode === 'reading' ? 'live' : 'reading');
    }
  }

  /** A checkbox in the reading view: tick/untick that line if it really is a task item. */
  function toggleTask(line: number): void {
    if (readonly || !editor) return;
    const doc = editor.view.state.doc;
    if (!Number.isInteger(line) || line < 0 || line >= doc.lines) return;
    const l = doc.line(line + 1);
    const c = taskToggle(l.text, 0);
    if (!c) return;
    editor.view.dispatch({ changes: { from: l.from + c.from, to: l.from + c.to, insert: c.insert }, userEvent: 'input' });
  }

  async function resolveConflict(choice: 'mine' | 'disk' | 'both'): Promise<void> {
    await saver?.resolve(choice);
    sync();
  }

  function saveNow(): void {
    void saver?.flush();
  }

  async function saveAsNew(): Promise<void> {
    await saver?.saveAsNew();
    sync();
  }

  onMount(() => {
    void load();
  });

  onDestroy(() => {
    destroyed = true;
    if (published && get(activeNote) === published) activeNote.set(null);
    for (const fn of cleanups) fn();
    saver?.close();
    editor?.destroy();
  });

  const statusText = $derived(de.editor.status[saveState]);
</script>

<svelte:window onkeydown={onKeydown} />

<div class="note-view">
  {#if loadState === 'loading'}
    <p class="placeholder" role="status">{de.reading.loading}</p>
  {:else if loadState === 'notUtf8'}
    <div class="placeholder" role="alert">
      <p>{de.reading.notUtf8}</p>
      <a class="link-button" href={api.file.url(path)} download>{de.reading.download}</a>
    </div>
  {:else if loadState === 'error'}
    <div class="placeholder" role="alert">
      <p>{de.reading.loadFailed}</p>
      <button type="button" class="link-button" onclick={load}>{de.retry}</button>
    </div>
  {:else}
    <div class="note-header">
      <ModeSwitch {mode} onChange={setMode} />
      {#if !readonly}
        <span class="save-state" class:warn={saveState === 'offline' || saveState === 'conflict' || saveState === 'error'} role="status"
          >{statusText}{#if saveState === 'error' && errorMessage}: {errorMessage}{/if}</span
        >
        {#if saveState === 'offline' || saveState === 'error'}
          <button type="button" class="link-button" onclick={saveNow}>{de.editor.retry}</button>
        {/if}
      {/if}
    </div>

    {#if readonly}
      <p class="banner" role="note">{de.editor.readonly}</p>
    {/if}
    {#if uploadError}
      <div class="banner warn" role="alert">
        <span>{uploadError}</span>
        <button type="button" class="link-button" onclick={() => (uploadError = '')}>{de.editor.dismiss}</button>
      </div>
    {/if}
    {#if draftRestored}
      <p class="banner" role="status">{de.editor.draftRestored}</p>
    {/if}
    {#if goneOnDisk || deleted}
      <div class="banner warn" role="alert">
        <span>{unsaved ? de.editor.deletedUnsaved : de.tabs.deleted}</span>
        {#if unsaved && !readonly}
          <button type="button" class="link-button" onclick={saveAsNew}>{de.editor.saveAsNew}</button>
        {/if}
        {#if onCloseTab}<button type="button" class="link-button" onclick={onCloseTab}>{de.tabs.closeTab}</button>{/if}
      </div>
    {/if}

    <div class="note-body">
      <div class="editor-host" bind:this={editorHost} hidden={mode === 'reading'}></div>
      {#if mode === 'reading'}
        <div class="reading-scroll">
          <ReadingView bind:this={readingView} {path} content={text} {lookup} {subpath} {onOpenLink} {onTag} onToggleTask={toggleTask} />
        </div>
      {/if}
    </div>

    {#if conflict}
      <ConflictDialog {path} {conflict} onResolve={resolveConflict} />
    {/if}
  {/if}
</div>

<style>
  .note-view {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
  }
  .note-header {
    display: flex;
    align-items: center;
    gap: var(--size-4);
    padding: var(--size-2) var(--size-4);
    border-bottom: 1px solid var(--background-modifier-border);
    font-size: var(--font-ui-smaller);
  }
  .save-state {
    color: var(--text-faint);
  }
  .save-state.warn {
    color: var(--text-error);
  }
  .banner {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--size-3);
    margin: 0;
    padding: var(--size-3) var(--size-4);
    background: var(--background-secondary);
    border-bottom: 1px solid var(--background-modifier-border);
    color: var(--text-muted);
    font-size: var(--font-ui-small);
  }
  .banner.warn {
    background: var(--background-modifier-error-soft);
    color: var(--text-normal);
  }
  .note-body {
    flex: 1;
    min-height: 0;
    position: relative;
  }
  .editor-host {
    height: 100%;
  }
  .editor-host[hidden] {
    display: none;
  }
  .reading-scroll {
    height: 100%;
    overflow: auto;
  }
  .placeholder {
    max-width: 720px;
    margin: 0 auto;
    padding: var(--size-6);
    color: var(--text-faint);
  }
</style>

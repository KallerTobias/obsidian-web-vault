<script lang="ts">
  import { onMount, tick } from 'svelte';
  import CommandPalette from './components/CommandPalette.svelte';
  import FileTree from './components/FileTree.svelte';
  import Login from './components/Login.svelte';
  import QuickSwitcher from './components/QuickSwitcher.svelte';
  import RightPanel from './components/RightPanel.svelte';
  import SearchPane from './components/SearchPane.svelte';
  import SessionExpired from './components/SessionExpired.svelte';
  import Setup from './components/Setup.svelte';
  import Shell from './components/Shell.svelte';
  import Sidebar from './components/Sidebar.svelte';
  import TabContent from './components/TabContent.svelte';
  import TagPane from './components/TagPane.svelte';
  import ViewSwitcher, { type SidebarView } from './components/ViewSwitcher.svelte';
  import Tabs from './components/Tabs.svelte';
  import ThemeToggle from './components/ThemeToggle.svelte';
  import { api } from './lib/api';
  import { applyRename, hasUnsavedNotes, keepAllDrafts } from './lib/editor/save';
  import { registerCommandActions } from './lib/commands';
  import { openDailyNote } from './lib/new-note';
  import { de } from './lib/i18n/de';
  import { events } from './lib/stores/events';
  import { session } from './lib/stores/session';
  import { editorSettings } from './lib/stores/settings';
  import { theme } from './lib/stores/theme';
  import { vault } from './lib/stores/vault';
  import { workspace } from './lib/stores/workspace';

  const { state: sessionState, expired } = session;
  let loadFailed = $state(false);
  /** Whether a passkey exists: decides if the setup screen offers "go to login". */
  let hasPasskeys = $state(false);
  /** PUBLIC_URL's origin: login and setup only work there. */
  let publicOrigin = $state<string | undefined>(undefined);
  let fileTree = $state<FileTree>();
  let treeFailed = $state(false);
  let shell = $state<Shell>();
  let searchPane = $state<SearchPane>();
  let sidebarView = $state<SidebarView>('files');
  let searchQuery = $state('');
  let quickOpen = $state(false);
  let paletteOpen = $state(false);
  const { tree } = vault;
  const activeTab = $derived($workspace.tabs[$workspace.active]);

  function showView(view: SidebarView): void {
    sidebarView = view;
    shell?.openSide('left');
  }

  /** Mod-Shift-f and the "Suche" command. */
  function openSearch(): void {
    showView('search');
    // The pane is hidden until the view switched.
    void tick().then(() => searchPane?.focus());
  }

  /** A tag was clicked somewhere: search for it. */
  function searchTag(tag: string): void {
    searchQuery = `tag:#${tag.replace(/^#/, '')}`;
    openSearch();
  }

  /** A short message above the workspace (daily notes switched off, a failed creation); `settings` offers the way there. */
  let notice = $state<{ text: string; settings: boolean } | null>(null);

  async function openToday(): Promise<void> {
    notice = null;
    try {
      const r = await openDailyNote();
      if (r.status === 'disabled') notice = { text: de.daily.disabled, settings: true };
    } catch (err) {
      notice = { text: de.daily.failed(err instanceof Error ? err.message : String(err)), settings: false };
    }
  }

  const currentPath = () => $workspace.tabs[$workspace.active]?.path;

  // The shell's own actions for the command palette.
  $effect(() =>
    registerCommandActions({
      newNote: () => fileTree?.newNoteInDefaultFolder(),
      newNoteFromTemplate: () => {
        showView('files');
        return tick().then(() => fileTree?.newNoteFromTemplate());
      },
      openDailyNote: openToday,
      openSearch,
      renameCurrent: () => {
        const p = currentPath();
        if (p) fileTree?.renamePath(p);
      },
      deleteCurrent: () => {
        const p = currentPath();
        return p ? fileTree?.trashPath(p) : undefined;
      },
      logout,
    }),
  );

  function onHotkey(e: KeyboardEvent): void {
    if (e.defaultPrevented || $sessionState !== 'ready' || e.isComposing) return;
    if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
    const key = e.key.toLowerCase();
    const wanted = e.shiftKey ? key === 'f' : key === 'o' || key === 'p';
    if (!wanted) return;
    // Not underneath a modal (rename, conflict, login, the other palette …), nor inside CodeMirror's search panel.
    if (document.querySelector('dialog[open]')) return;
    if ((e.target as Element | null)?.closest?.('.cm-search')) return;
    e.preventDefault();
    if (e.shiftKey) openSearch();
    else if (key === 'o') quickOpen = true;
    else paletteOpen = true;
  }

  function loadVault(): void {
    treeFailed = false;
    vault.load().catch(() => (treeFailed = true));
  }

  // While logged in: load the vault and follow its changes.
  $effect(() => {
    if ($sessionState !== 'ready') return;
    loadVault();
    events.connect();
    return () => events.disconnect();
  });

  async function load(): Promise<void> {
    loadFailed = false;
    try {
      const s = await api.auth.state();
      hasPasskeys = !s.setupRequired;
      publicOrigin = s.publicOrigin;
      // A setup link (`/setup#token`) also adds a passkey when others exist (issued via CLI).
      const setupLink = location.pathname === '/setup' && location.hash.length > 1;
      if (setupLink) sessionState.set('setup');
      else if (s.authenticated) enterApp();
      else sessionState.set(s.setupRequired ? 'setup' : 'login');
    } catch {
      loadFailed = true;
    }
  }

  function enterApp(): void {
    if (location.pathname === '/setup') history.replaceState(history.state, '', '/');
    expired.set(false);
    sessionState.set('ready');
    api.settings.get().then(
      (s) => {
        theme.set(s.theme);
        editorSettings.set({ newLinkFormat: s.newLinkFormat, attachmentFolder: s.attachmentFolder });
      },
      () => {},
    );
  }

  async function logout(): Promise<void> {
    // Even if the request fails, show the login: the cookie is gone or the server unreachable.
    events.disconnect();
    await api.auth.logout().catch(() => {});
    expired.set(false);
    sessionState.set('login');
  }

  /** Leaving with unsaved notes: keep their text as drafts and let the browser ask. */
  function beforeUnload(e: BeforeUnloadEvent): void {
    if (!hasUnsavedNotes()) return;
    keepAllDrafts();
    e.preventDefault();
    e.returnValue = de.editor.unloadWarning;
  }

  onMount(() => {
    void load();
  });
</script>

{#if $sessionState === 'loading'}
  <div class="auth-screen" aria-busy="true">
    {#if loadFailed}
      <div class="auth-card" role="alert">
        <p>{de.loadFailed}</p>
        <button type="button" class="button-primary" onclick={load}>{de.retry}</button>
      </div>
    {:else}
      <p class="loading">{de.loading}</p>
    {/if}
  </div>
{:else if $sessionState === 'setup'}
  <div class="auth-screen">
    <Setup onSuccess={enterApp} onLogin={hasPasskeys ? () => sessionState.set('login') : undefined} {publicOrigin} />
  </div>
{:else if $sessionState === 'login'}
  <div class="auth-screen">
    <Login onSuccess={enterApp} {publicOrigin} />
  </div>
{:else}
  <Shell bind:this={shell}>
    {#snippet toolbar()}
      <ThemeToggle />
      <button type="button" class="icon-button" aria-label={de.shell.logout} title={de.shell.logout} onclick={logout}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" />
        </svg>
      </button>
    {/snippet}
    {#snippet left()}
      <div class="left">
        <ViewSwitcher view={sidebarView} onSelect={(v) => (v === 'search' ? openSearch() : showView(v))} onGraph={() => workspace.openGraph()} />
        <div class="view" id="view-files" role="tabpanel" aria-labelledby="view-tab-files" hidden={sidebarView !== 'files'}>
      <Sidebar title={de.shell.files}>
        {#snippet actions()}
          <button type="button" class="icon-button" aria-label={de.files.newNote} title={de.files.newNote} onclick={() => fileTree?.newNoteInDefaultFolder()} disabled={!$tree}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9zM14 3v6h6M12 12v6M9 15h6" />
            </svg>
          </button>
          <button type="button" class="icon-button" aria-label={de.files.newFolder} title={de.files.newFolder} onclick={() => fileTree?.newFolderInRoot()} disabled={!$tree}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM12 11v5M9.5 13.5h5" />
            </svg>
          </button>
          <button type="button" class="icon-button" aria-label={de.files.collapseAll} title={de.files.collapseAll} onclick={() => fileTree?.collapseAll()} disabled={!$tree}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M7 20l5-5 5 5M7 4l5 5 5-5" />
            </svg>
          </button>
        {/snippet}
        {#if $tree}
          <FileTree
            bind:this={fileTree}
            root={$tree}
            currentPath={activeTab?.path}
            onOpen={(path, opts) => workspace.open(path, opts)}
            onRenamed={(from, to) => {
              applyRename(from, to);
              workspace.applyEvent({ seq: 0, type: 'renamed', from, to });
            }}
            onTrashed={(path) => workspace.applyEvent({ seq: 0, type: 'deleted', path })}
            onChanged={loadVault}
          />
        {:else if treeFailed}
          <div role="alert">
            <p>{de.files.loadFailed}</p>
            <button type="button" class="link-button" onclick={loadVault}>{de.retry}</button>
          </div>
        {:else}
          <p class="loading">{de.loading}</p>
        {/if}
      </Sidebar>
        </div>
        <div class="view" id="view-search" role="tabpanel" aria-labelledby="view-tab-search" hidden={sidebarView !== 'search'}>
          <Sidebar title={de.sidebar.search}>
            <SearchPane bind:this={searchPane} bind:query={searchQuery} onOpen={(path, opts) => workspace.open(path, opts)} />
          </Sidebar>
        </div>
        <div class="view" id="view-tags" role="tabpanel" aria-labelledby="view-tab-tags" hidden={sidebarView !== 'tags'}>
          <Sidebar title={de.sidebar.tags}><TagPane onSelect={searchTag} /></Sidebar>
        </div>
      </div>
    {/snippet}
    {#snippet main()}
      <div class="workspace">
        <Tabs />
        {#if notice}
          <div class="notice" role="status">
            <span>{notice.text}</span>
            {#if notice.settings}
              <button type="button" class="link-button" onclick={() => { workspace.openSettings(); notice = null; }}>{de.daily.toSettings}</button>
            {/if}
            <button type="button" class="link-button" onclick={() => (notice = null)}>{de.daily.dismiss}</button>
          </div>
        {/if}
        <div class="tab-content"><TabContent onTag={searchTag} /></div>
      </div>
    {/snippet}
    {#snippet right()}
      <Sidebar title={de.shell.details}><RightPanel /></Sidebar>
    {/snippet}
  </Shell>

  {#if quickOpen}
    <QuickSwitcher onOpen={(path, opts) => workspace.open(path, opts)} onClose={() => (quickOpen = false)} />
  {/if}
  {#if paletteOpen}
    <CommandPalette onClose={() => (paletteOpen = false)} />
  {/if}

  <SessionExpired />
{/if}

<svelte:window onbeforeunload={beforeUnload} onkeydown={onHotkey} />

<style>
  .left {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
  }
  .view {
    flex: 1;
    min-height: 0;
  }
  .view[hidden] {
    display: none;
  }
  .loading {
    color: var(--text-faint);
    font-size: var(--font-ui-small);
  }
  .workspace {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
  }
  .notice {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--size-4);
    padding: var(--size-3) var(--size-5);
    background: var(--background-secondary);
    border-bottom: 1px solid var(--background-modifier-border);
    font-size: var(--font-ui-small);
    color: var(--text-muted);
  }
  .tab-content {
    flex: 1;
    min-height: 0;
  }
</style>

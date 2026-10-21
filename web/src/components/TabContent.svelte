<script lang="ts">
  import { createFileLookup } from '@shared/resolve';
  import { api } from '../lib/api';
  import { de } from '../lib/i18n/de';
  import { vault } from '../lib/stores/vault';
  import { workspace } from '../lib/stores/workspace';
  import GraphView from '../lib/graph/GraphView.svelte';
  import EmptyState from './EmptyState.svelte';
  import MediaView from './MediaView.svelte';
  import NoteView from './NoteView.svelte';
  import SettingsView from './SettingsView.svelte';
  import type { OpenLinkOptions } from './ReadingView.svelte';
  import { panelId, tabId } from './Tabs.svelte';

  /** The active tab's content. */
  let { onTag }: { onTag?: (tag: string) => void } = $props();
  const index = $derived($workspace.active);
  const tab = $derived($workspace.tabs[index]);
  const { lookup: lookupEntries } = vault;
  const lookup = $derived(createFileLookup($lookupEntries.map((e) => e.path)));
  let createError = $state(false);
  // A failed creation belongs to the note it was tried from.
  $effect(() => {
    void tab?.path;
    createError = false;
  });

  async function openLink(target: string, opts: OpenLinkOptions): Promise<void> {
    createError = false;
    if (!opts.unresolved) {
      workspace.open(target, { newTab: opts.newTab, subpath: opts.subpath });
      return;
    }
    // Unresolved: create the note (path as written, `.md` added) and open it.
    const path = /\.md$/i.test(target) ? target : `${target}.md`;
    try {
      const created = await api.note.create(path, '');
      workspace.open(created.path, { newTab: opts.newTab });
    } catch {
      createError = true;
    }
  }
</script>

{#if !tab}
  <EmptyState />
{:else}
  <div id={panelId} class="panel" role="tabpanel" aria-labelledby={tabId(index)} tabindex="-1">
    {#if tab.deleted && tab.kind !== 'note'}
      <div class="notice" role="status">
        <p>{de.tabs.deleted}</p>
        <button type="button" class="link-button" onclick={() => workspace.close(index)}>{de.tabs.closeTab}</button>
      </div>
    {:else if tab.kind === 'note' && tab.path}
      {#if createError}<p class="notice" role="alert">{de.reading.createFailed}</p>{/if}
      <!-- A deleted note stays open: unsaved text must not vanish (NoteView offers to save it anew). -->
      {#key tab.path}
        <NoteView
          path={tab.path}
          subpath={tab.subpath}
          reveal={tab.reveal}
          deleted={tab.deleted}
          {lookup}
          onOpenLink={openLink}
          {onTag}
          onCloseTab={() => workspace.close(index)}
        />
      {/key}
    {:else if tab.kind === 'file' && tab.path}
      {#key tab.path}
        <MediaView path={tab.path} />
      {/key}
    {:else if tab.kind === 'graph'}
      {#if createError}<p class="notice" role="alert">{de.graph.createFailed}</p>{/if}
      <GraphView
        onOpen={(path, newTab) => workspace.open(path, { newTab })}
        {onTag}
        onUnresolved={(name, newTab) => openLink(name, { unresolved: true, newTab })}
      />
    {:else if tab.kind === 'settings'}
      <SettingsView />
    {/if}
  </div>
{/if}

<style>
  .panel {
    height: 100%;
    overflow: auto;
  }
  /* Notes scroll inside the editor/reading view (header and banners stay in place). */
  .panel:has(> :global(.note-view)),
  .panel:has(> :global(.graph-view)) {
    overflow: hidden;
  }
  .panel:focus {
    outline: none;
  }
  .notice {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--size-3);
    padding: var(--size-6);
    color: var(--text-muted);
    text-align: center;
  }
</style>

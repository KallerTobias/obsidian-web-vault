<script lang="ts">
  import { joinPath } from '@shared/normalize';
  import { fold } from '@shared/query';
  import { ApiError, api } from '../lib/api';
  import { de } from '../lib/i18n/de';
  import { isValidNoteName } from '../lib/names';
  import { quickMatches } from '../lib/quick';
  import { vault } from '../lib/stores/vault';
  import { workspace } from '../lib/stores/workspace';
  import Palette, { type PaletteItem } from './Palette.svelte';

  /**
   * Quick switcher (Mod-o): notes and their aliases, fuzzy; recent notes first without a query.
   * Enter opens, Ctrl/Cmd+Enter opens in a new tab. Without an exact match the last entry creates the note
   * (in the folder for new notes from the settings).
   */
  let {
    onOpen,
    onClose,
  }: {
    onOpen: (path: string, opts: { newTab: boolean }) => void;
    onClose: () => void;
  } = $props();

  const CREATE = '\u0000create';
  const { lookup } = vault;

  let query = $state('');
  let error = $state('');
  let busy = false;

  const matches = $derived(quickMatches($lookup, query, $workspace.recent));
  const name = $derived(query.trim().replace(/\.md$/i, ''));
  const exists = $derived($lookup.some((e) => e.path.toLowerCase().endsWith('.md') && fold(e.name) === fold(name)));
  const items = $derived<PaletteItem[]>([
    ...matches.map((m) => ({
      id: m.alias === undefined ? m.path : `${m.path}\u0000${m.alias}`,
      label: m.alias ?? m.name,
      detail: [m.alias === undefined ? '' : de.quick.aliasOf(m.name), m.folder].filter(Boolean).join(' · ') || undefined,
    })),
    ...(name !== '' && !exists ? [{ id: CREATE, label: de.quick.create(name) }] : []),
  ]);

  // The error belongs to the name it was shown for.
  $effect(() => {
    void query;
    error = '';
  });

  async function create(newTab: boolean): Promise<void> {
    if (busy) return;
    if (!isValidNoteName(name)) {
      error = de.quick.invalidName;
      return;
    }
    busy = true;
    try {
      const settings = await api.settings.get().catch(() => null);
      const folder = (settings?.newNoteFolder ?? '').replace(/^\/+|\/+$/g, '');
      const path = joinPath(folder, `${name}.md`);
      try {
        await api.note.create(path, '');
      } catch (err) {
        // The note exists already (not yet in our lookup): just open it.
        if (!(err instanceof ApiError && err.status === 409)) throw err;
      }
      void vault.load().catch(() => {});
      onClose();
      onOpen(path, { newTab });
    } catch (err) {
      error = de.quick.createFailed(err instanceof Error ? err.message : String(err));
    } finally {
      busy = false;
    }
  }

  function select(item: PaletteItem, newTab: boolean): void {
    if (item.id === CREATE) {
      void create(newTab);
      return;
    }
    onClose();
    onOpen(item.id.split('\u0000')[0]!, { newTab });
  }
</script>

<Palette
  title={de.quick.title}
  placeholder={de.quick.placeholder}
  bind:query
  {items}
  emptyText={de.quick.none}
  footer={error}
  onSelect={select}
  {onClose}
/>

<script lang="ts">
  import { tick } from 'svelte';
  import { commands, filterCommands, formatHotkey } from '../lib/commands';
  import { de } from '../lib/i18n/de';
  import Palette, { type PaletteItem } from './Palette.svelte';

  /** Command palette (Mod-p): every command, filtered by fuzzy search; Enter runs it. */
  let { onClose }: { onClose: () => void } = $props();

  let query = $state('');
  const matches = $derived(filterCommands(query, commands));
  const items = $derived<PaletteItem[]>(
    matches.map((c) => ({ id: c.id, label: c.name, hotkey: c.hotkey ? formatHotkey(c.hotkey) : undefined })),
  );

  async function select(item: PaletteItem): Promise<void> {
    const command = commands.find((c) => c.id === item.id);
    onClose();
    // Let the palette close (focus returns) before the command opens its own dialog or moves focus.
    await tick();
    await command?.run();
  }
</script>

<Palette
  title={de.palette.title}
  placeholder={de.palette.placeholder}
  bind:query
  {items}
  emptyText={de.palette.none}
  onSelect={(item) => void select(item)}
  {onClose}
/>

<script lang="ts">
  import { onMount } from 'svelte';
  import { fuzzyScore } from '../lib/fuzzy';
  import { api } from '../lib/api';
  import { t } from '../lib/i18n';
  import { createFromTemplate, InvalidNoteNameError } from '../lib/new-note';
  import { displayName, notesBelow } from '../lib/tree';
  import { vault } from '../lib/stores/vault';
  import { workspace } from '../lib/stores/workspace';
  import Palette, { type PaletteItem } from './Palette.svelte';

  /**
   * "Neue Notiz aus Vorlage": pick one of the notes in the templates folder (fuzzy), give the new note a title,
   * done. Without a templates folder (or without templates) it says so and points to the settings.
   */
  let {
    folder,
    onCreated,
    onClose,
  }: {
    /** Folder of the new note ('' = vault root). */
    folder: string;
    onCreated: (path: string) => void;
    onClose: () => void;
  } = $props();

  const { tree } = vault;

  /** `null` while the settings load. */
  let templatesFolder = $state<string | null>(null);
  let loadFailed = $state(false);
  let query = $state('');
  let chosen = $state<{ path: string; label: string } | null>(null);
  let title = $state('');
  let error = $state('');
  let busy = $state(false);
  let hintDialog = $state<HTMLDialogElement>();
  let titleDialog = $state<HTMLDialogElement>();
  let titleInput = $state<HTMLInputElement>();

  const templates = $derived.by(() => {
    if (!templatesFolder || !$tree) return [];
    const dir = templatesFolder;
    return notesBelow($tree, dir).map((t) => ({
      path: t.path,
      // Relative to the templates folder, so subfolders tell similar names apart.
      label: displayName({ name: t.path.slice(dir.length + 1), kind: 'note' }),
    }));
  });
  const items = $derived<PaletteItem[]>(
    query.trim() === ''
      ? templates.map((t) => ({ id: t.path, label: t.label }))
      : templates
          .map((t) => ({ t, score: fuzzyScore(query.trim(), t.label) }))
          .filter((x): x is { t: (typeof templates)[number]; score: number } => x.score !== null)
          .sort((a, b) => b.score - a.score)
          .map((x) => ({ id: x.t.path, label: x.t.label })),
  );
  const hint = $derived(
    loadFailed
      ? t.template.loadFailed
      : templatesFolder === ''
        ? t.template.noFolder
        : templatesFolder !== null && templates.length === 0 && $tree
          ? t.template.noTemplates(templatesFolder)
          : '',
  );

  onMount(() => {
    api.settings.get().then(
      (s) => (templatesFolder = s.templatesFolder.replace(/^\/+|\/+$/g, '')),
      () => {
        loadFailed = true;
        templatesFolder = '';
      },
    );
  });

  function show(dialog: HTMLDialogElement | undefined): void {
    // jsdom (tests) has no showModal.
    if (!dialog || dialog.open) return;
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.setAttribute('open', '');
  }

  $effect(() => show(hintDialog));
  $effect(() => {
    show(titleDialog);
    titleInput?.focus();
    titleInput?.select();
  });

  function choose(item: PaletteItem): void {
    chosen = { path: item.id, label: item.label };
    title = '';
    error = '';
  }

  async function submit(e: SubmitEvent): Promise<void> {
    e.preventDefault();
    if (busy || !chosen) return;
    busy = true;
    error = '';
    try {
      const path = await createFromTemplate(chosen.path, folder, title);
      onCreated(path);
      onClose();
    } catch (err) {
      error = err instanceof InvalidNoteNameError ? err.message : t.template.createFailed(err instanceof Error ? err.message : String(err));
    } finally {
      busy = false;
    }
  }

  function toSettings(): void {
    workspace.openSettings();
    onClose();
  }
</script>

{#if chosen}
  <dialog
    bind:this={titleDialog}
    class="template-dialog"
    aria-labelledby="template-title"
    oncancel={(e) => {
      e.preventDefault();
      if (!busy) onClose();
    }}
  >
    <form onsubmit={submit}>
      <h2 id="template-title">{t.template.titleHeading(chosen.label)}</h2>
      <label class="field">
        <span class="field-label">{t.template.titleLabel}</span>
        <input
          bind:this={titleInput}
          bind:value={title}
          class="text-input"
          autocomplete="off"
          spellcheck="false"
          placeholder={t.files.untitled}
          aria-describedby="template-title-hint"
        />
      </label>
      <p id="template-title-hint" class="field-hint">{t.template.titleHint(folder)}</p>
      {#if error}<p class="error-message" role="alert">{error}</p>{/if}
      <div class="buttons">
        <button type="button" class="link-button" onclick={onClose} disabled={busy}>{t.template.cancel}</button>
        <button type="submit" class="button-primary" disabled={busy}>{busy ? t.template.busy : t.template.create}</button>
      </div>
    </form>
  </dialog>
{:else if hint}
  <dialog
    bind:this={hintDialog}
    class="template-dialog"
    aria-labelledby="template-hint-title"
    oncancel={(e) => {
      e.preventDefault();
      onClose();
    }}
  >
    <h2 id="template-hint-title">{t.template.title}</h2>
    <p role={loadFailed ? 'alert' : 'status'}>{hint}</p>
    <div class="buttons">
      <button type="button" class="link-button" onclick={onClose}>{t.template.close}</button>
      {#if !loadFailed}<button type="button" class="button-primary" onclick={toSettings}>{t.template.toSettings}</button>{/if}
    </div>
  </dialog>
{:else if templatesFolder !== null}
  <Palette
    title={t.template.title}
    placeholder={t.template.placeholder}
    bind:query
    {items}
    emptyText={t.template.none}
    onSelect={choose}
    {onClose}
  />
{/if}

<style>
  .template-dialog {
    width: min(440px, calc(100vw - 32px));
    padding: var(--size-6);
    border: 1px solid var(--background-modifier-border);
    border-radius: var(--radius-l);
    background: var(--background-primary);
    color: var(--text-normal);
    box-shadow: var(--shadow-l);
  }
  .template-dialog::backdrop {
    background: var(--background-modifier-cover);
  }
  h2 {
    margin: 0 0 var(--size-4);
    font-size: var(--font-ui-medium);
  }
  p {
    margin: 0;
    font-size: var(--font-ui-small);
    color: var(--text-muted);
  }
  .field-hint {
    margin-top: var(--size-2);
    font-size: var(--font-ui-smaller);
  }
  .buttons {
    display: flex;
    justify-content: flex-end;
    align-items: center;
    gap: var(--size-4);
    margin-top: var(--size-5);
  }
  .buttons .button-primary {
    width: auto;
  }
</style>

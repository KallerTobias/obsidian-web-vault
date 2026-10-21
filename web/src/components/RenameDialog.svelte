<script lang="ts">
  import { basename, dirname } from '@shared/normalize';
  import { ApiError, api, type RenameResult } from '../lib/api';
  import { flushSaversUnder } from '../lib/editor/save';
  import { t } from '../lib/i18n';
  import { isValidNoteName } from '../lib/names';

  /**
   * Rename or move a file/folder. Counts the notes linking to it (`/api/rename/affected`) and offers
   * to adjust their links (default: yes). Afterwards it reports links it could not adjust.
   */
  let {
    path,
    kind,
    mode,
    target,
    folders = [],
    onDone,
    onClose,
  }: {
    path: string;
    kind: 'folder' | 'note' | 'file';
    mode: 'rename' | 'move';
    /** Move: the preselected target folder (e.g. from drag & drop). */
    target?: string;
    /** Move: folder suggestions ('' = vault root). */
    folders?: string[];
    /** The rename happened (even if some links could not be adjusted). */
    onDone?: (from: string, to: string, result: RenameResult) => void;
    onClose: () => void;
  } = $props();

  const listId = `rename-folders-${Math.random().toString(36).slice(2)}`;
  const isNote = $derived(kind === 'note' && path.toLowerCase().endsWith('.md'));
  /** Notes are named without `.md`; the extension is kept as it was. */
  const ext = $derived(isNote ? path.slice(-3) : '');

  let dialog = $state<HTMLDialogElement>();
  let input = $state<HTMLInputElement>();
  // The dialog is mounted once per rename: the fields start from the props and are then the user's.
  /** The current name as shown in the field (notes without `.md`). */
  const originalName = $derived(isNote ? basename(path).slice(0, -3) : basename(path));
  // svelte-ignore state_referenced_locally
  let name = $state(originalName);
  // svelte-ignore state_referenced_locally
  let folder = $state(target ?? dirname(path));
  let affected = $state<number | null>(null);
  let updateLinks = $state(true);
  let busy = $state(false);
  let error = $state('');
  let result = $state<RenameResult | null>(null);

  const problems = $derived(
    result ? result.skippedReadonly.length + result.conflicts.length + result.failed.length : 0,
  );

  $effect(() => {
    if (!dialog) return;
    // jsdom (tests) has no showModal.
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.setAttribute('open', '');
    input?.focus();
    if (mode === 'rename') input?.select();
  });

  $effect(() => {
    let stale = false;
    api.renameAffected(path).then(
      (r) => {
        if (!stale) affected = r.count;
      },
      () => {
        if (!stale) affected = 0;
      },
    );
    return () => {
      stale = true;
    };
  });

  function newPath(): string | null {
    const n = name.trim();
    // Only a new name is checked: moving `Notiz #1.md` (or renaming nothing) keeps an existing name.
    const changed = n !== originalName;
    if (!n || (changed && !isValidNoteName(n))) {
      error = t.rename.invalidName;
      return null;
    }
    const dir = folder.trim().replace(/^\/+|\/+$/g, '');
    const to = (dir ? `${dir}/` : '') + n + ext;
    if (kind === 'folder' && to.startsWith(`${path}/`)) {
      error = t.rename.intoItself;
      return null;
    }
    return to;
  }

  async function submit(e: SubmitEvent): Promise<void> {
    e.preventDefault();
    if (busy || result) return;
    error = '';
    const to = newPath();
    if (to === null) return;
    if (to === path) {
      onClose();
      return;
    }
    busy = true;
    try {
      // Pending edits go to the old path first (a failed save keeps its draft, which follows the rename).
      await flushSaversUnder(path);
      const r = await api.rename(path, to, updateLinks && (affected ?? 0) > 0);
      onDone?.(path, to, r);
      if (r.skippedReadonly.length + r.conflicts.length + r.failed.length === 0) onClose();
      else result = r;
    } catch (err) {
      error = err instanceof ApiError || err instanceof Error ? err.message : t.errors.unexpected;
    } finally {
      busy = false;
    }
  }
</script>

<dialog
  bind:this={dialog}
  class="rename-dialog"
  aria-labelledby="rename-title"
  oncancel={(e) => {
    e.preventDefault();
    if (!busy) onClose();
  }}
>
  <form onsubmit={submit}>
    <h2 id="rename-title">{mode === 'rename' ? t.rename.titleRename : t.rename.titleMove}</h2>
    <p class="path">{path}</p>

    {#if result}
      <div role="status">
        <p><strong>{t.rename.doneTitle}</strong></p>
        {#if result.updated.length}<p>{t.rename.updated(result.updated.length)}</p>{/if}
        {#each [{ label: t.rename.skippedReadonly, list: result.skippedReadonly }, { label: t.rename.conflicts, list: result.conflicts }, { label: t.rename.failed, list: result.failed }] as group (group.label)}
          {#if group.list.length}
            <p class="group-label">{group.label}</p>
            <ul>
              {#each group.list as p (p)}<li>{p}</li>{/each}
            </ul>
          {/if}
        {/each}
      </div>
      <div class="buttons">
        <button type="button" class="button-primary" onclick={onClose}>{t.rename.close}</button>
      </div>
    {:else}
      {#if mode === 'rename'}
        <label class="field">
          <span class="field-label">{t.rename.name}</span>
          <input bind:this={input} bind:value={name} class="text-input" autocomplete="off" spellcheck="false" />
        </label>
      {:else}
        <label class="field">
          <span class="field-label">{t.rename.folder}</span>
          <input
            bind:this={input}
            bind:value={folder}
            class="text-input"
            list={listId}
            autocomplete="off"
            spellcheck="false"
            placeholder={t.rename.rootFolder}
            aria-describedby="{listId}-hint"
          />
        </label>
        <p id="{listId}-hint" class="field-hint">{t.rename.folderHint}</p>
        <datalist id={listId}>
          {#each folders.filter((f) => f !== '') as f (f)}<option value={f}></option>{/each}
        </datalist>
      {/if}

      {#if affected === null}
        <p class="hint">{t.rename.counting}</p>
      {:else if affected > 0}
        <label class="check">
          <input type="checkbox" bind:checked={updateLinks} />
          <span>{t.rename.affected(affected)}</span>
        </label>
      {/if}

      {#if error}<p class="error-message" role="alert">{error}</p>{/if}

      <div class="buttons">
        <button type="button" class="link-button" onclick={onClose} disabled={busy}>{t.rename.cancel}</button>
        <button type="submit" class="button-primary" disabled={busy || affected === null}>
          {busy ? t.rename.busy : mode === 'rename' ? t.rename.submitRename : t.rename.submitMove}
        </button>
      </div>
    {/if}
  </form>
</dialog>

<style>
  .rename-dialog {
    width: min(440px, calc(100vw - 32px));
    padding: var(--size-6);
    border: 1px solid var(--background-modifier-border);
    border-radius: var(--radius-l);
    background: var(--background-primary);
    color: var(--text-normal);
    box-shadow: var(--shadow-l);
  }
  .rename-dialog::backdrop {
    background: var(--background-modifier-cover);
  }
  h2 {
    margin: 0 0 var(--size-2);
    font-size: var(--font-ui-medium);
  }
  .path {
    margin: 0 0 var(--size-5);
    color: var(--text-faint);
    font-size: var(--font-ui-smaller);
    overflow-wrap: anywhere;
  }
  .field-hint {
    margin: var(--size-2) 0 0;
    font-size: var(--font-ui-smaller);
  }
  .hint {
    color: var(--text-faint);
    font-size: var(--font-ui-small);
  }
  .check {
    display: flex;
    gap: var(--size-3);
    align-items: flex-start;
    margin: var(--size-4) 0;
    font-size: var(--font-ui-small);
  }
  .group-label {
    margin: var(--size-4) 0 var(--size-2);
    font-size: var(--font-ui-small);
    color: var(--text-muted);
  }
  ul {
    margin: 0;
    padding-left: var(--size-5);
    max-height: 160px;
    overflow: auto;
    font-size: var(--font-ui-small);
    overflow-wrap: anywhere;
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

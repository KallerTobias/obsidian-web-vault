<script lang="ts">
  import { dailyNotePath } from '@shared/template';
  import { onDestroy, onMount } from 'svelte';
  import { api, type Settings, type SettingsPatch } from '../lib/api';
  import { beforeLanguageReload, t as messages } from '../lib/i18n';
  import { editorSettings } from '../lib/stores/settings';
  import { theme, type ThemePreference } from '../lib/stores/theme';
  import { vault } from '../lib/stores/vault';
  import { folderPaths } from '../lib/tree';
  import LanguageSelect from './LanguageSelect.svelte';
  import PasskeyList from './PasskeyList.svelte';
  import SessionList from './SessionList.svelte';

  /** Changes are saved this long after the last one. */
  const SAVE_DELAY_MS = 500;
  const t = messages.settings;
  const uid = `settings-${Math.random().toString(36).slice(2, 8)}`;
  const { tree } = vault;

  let loaded = $state<Pick<Settings, 'attachmentFolder' | 'newLinkFormat' | 'newNoteFolder' | 'templatesFolder' | 'dailyNotes'> | null>(null);
  let loadFailed = $state(false);
  let status = $state<'idle' | 'saving' | 'saved' | 'error'>('idle');
  let saveError = $state('');

  // Form fields (filled from the server once loaded).
  let attachmentFolder = $state('');
  let newLinkFormat = $state<Settings['newLinkFormat']>('shortest');
  let newNoteFolder = $state('');
  let templatesFolder = $state('');
  let dailyEnabled = $state(false);
  let dailyFolder = $state('');
  let dailyFormat = $state('YYYY-MM-DD');
  let dailyTemplate = $state('');

  const folders = $derived($tree ? folderPaths($tree).filter((f) => f !== '') : []);
  const dailyPreview = $derived(dailyFormat.trim() ? dailyNotePath(new Date(), dailyFolder.trim(), dailyFormat.trim()) : '');

  // Only changed keys are sent: the server merges them, so e.g. the graph settings (owned by the graph tab) stay as they are.
  let pending: SettingsPatch = {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  let savedTimer: ReturnType<typeof setTimeout> | undefined;

  function queue(patch: SettingsPatch): void {
    const { dailyNotes, ...flat } = patch;
    pending = { ...pending, ...flat, ...(dailyNotes ? { dailyNotes: { ...pending.dailyNotes, ...dailyNotes } } : {}) };
    status = 'saving';
    clearTimeout(timer);
    timer = setTimeout(flush, SAVE_DELAY_MS);
  }

  async function flush(): Promise<void> {
    clearTimeout(timer);
    timer = undefined;
    const patch = pending;
    if (Object.keys(patch).length === 0) return;
    pending = {};
    try {
      await api.settings.update(patch);
      // Another change may be waiting already.
      if (timer === undefined) {
        status = 'saved';
        clearTimeout(savedTimer);
        savedTimer = setTimeout(() => (status = 'idle'), 3000);
      }
    } catch (err) {
      pending = { ...patch, ...pending, dailyNotes: { ...patch.dailyNotes, ...pending.dailyNotes } };
      if (!pending.dailyNotes || Object.keys(pending.dailyNotes).length === 0) delete pending.dailyNotes;
      status = 'error';
      saveError = t.saveFailed(err instanceof Error ? err.message : String(err));
    }
  }

  onMount(() => {
    api.settings.get().then(
      (s) => {
        loaded = s;
        attachmentFolder = s.attachmentFolder;
        newLinkFormat = s.newLinkFormat;
        newNoteFolder = s.newNoteFolder;
        templatesFolder = s.templatesFolder;
        dailyEnabled = s.dailyNotes.enabled;
        dailyFolder = s.dailyNotes.folder;
        dailyFormat = s.dailyNotes.format;
        dailyTemplate = s.dailyNotes.template;
      },
      () => (loadFailed = true),
    );
  });

  // A language change reloads the page: a change still waiting is sent first.
  const offReload = beforeLanguageReload(flush);

  // Leaving the tab must not lose a change that is still waiting.
  onDestroy(() => {
    offReload();
    clearTimeout(savedTimer);
    void flush();
  });

  function setEditor(patch: Partial<{ attachmentFolder: string; newLinkFormat: Settings['newLinkFormat'] }>): void {
    editorSettings.update((e) => ({ ...e, ...patch }));
  }

  function setTheme(value: ThemePreference): void {
    theme.set(value);
    queue({ theme: value });
  }

  const THEMES: ThemePreference[] = ['system', 'light', 'dark'];
</script>

<div class="settings" role="region" aria-labelledby="{uid}-title" onfocusout={() => void flush()}>
  <header>
    <h2 id="{uid}-title">{t.title}</h2>
    <p class="status" role="status" aria-live="polite">
      {#if status === 'saving'}{t.saving}{:else if status === 'saved'}{t.saved}{/if}
    </p>
  </header>
  {#if status === 'error'}<p class="error-message" role="alert">{saveError}</p>{/if}

  <!-- Per device (localStorage), so it works even when the server settings cannot be loaded. -->
  <section aria-labelledby="{uid}-language">
    <h3 id="{uid}-language">{t.language.heading}</h3>
    <div class="field">
      <label class="field-label" for="{uid}-lang">{t.language.label}</label>
      <LanguageSelect id="{uid}-lang" describedby="{uid}-lang-hint" />
      <span class="field-hint" id="{uid}-lang-hint">{t.language.hint}</span>
    </div>
  </section>

  {#if loadFailed}
    <p class="error-message" role="alert">{t.loadFailed}</p>
  {:else if loaded}
    <datalist id="{uid}-folders">
      {#each folders as f (f)}<option value={f}></option>{/each}
    </datalist>

    <section aria-labelledby="{uid}-files">
      <h3 id="{uid}-files">{t.files.heading}</h3>
      <div class="field">
        <label class="field-label" for="{uid}-f1">{t.files.attachmentFolder}</label>
        <input
          id="{uid}-f1"
          aria-describedby="{uid}-h1"
          class="text-input"
          list="{uid}-folders"
          autocomplete="off"
          spellcheck="false"
          bind:value={attachmentFolder}
          oninput={() => {
            setEditor({ attachmentFolder: attachmentFolder.trim() });
            queue({ attachmentFolder: attachmentFolder.trim() });
          }}
        />
        <span class="field-hint" id="{uid}-h1">{t.files.attachmentHint}</span>
      </div>
      <div class="field">
        <label class="field-label" for="{uid}-f2">{t.files.linkFormat}</label>
        <select
          id="{uid}-f2"
          class="text-input"
          bind:value={newLinkFormat}
          onchange={() => {
            setEditor({ newLinkFormat });
            queue({ newLinkFormat });
          }}
        >
          <option value="shortest">{t.files.shortest}</option>
          <option value="absolute">{t.files.absolute}</option>
          <option value="relative">{t.files.relative}</option>
        </select>
      </div>
      <div class="field">
        <label class="field-label" for="{uid}-f3">{t.files.newNoteFolder}</label>
        <input
          id="{uid}-f3"
          aria-describedby="{uid}-h3"
          class="text-input"
          list="{uid}-folders"
          autocomplete="off"
          spellcheck="false"
          bind:value={newNoteFolder}
          oninput={() => queue({ newNoteFolder: newNoteFolder.trim() })}
        />
        <span class="field-hint" id="{uid}-h3">{t.files.newNoteHint}</span>
      </div>
    </section>

    <section aria-labelledby="{uid}-templates">
      <h3 id="{uid}-templates">{t.templates.heading}</h3>
      <div class="field">
        <label class="field-label" for="{uid}-f4">{t.templates.folder}</label>
        <input
          id="{uid}-f4"
          aria-describedby="{uid}-h4"
          class="text-input"
          list="{uid}-folders"
          autocomplete="off"
          spellcheck="false"
          bind:value={templatesFolder}
          oninput={() => queue({ templatesFolder: templatesFolder.trim() })}
        />
        <span class="field-hint" id="{uid}-h4">{t.templates.hint}</span>
      </div>
    </section>

    <section aria-labelledby="{uid}-daily">
      <h3 id="{uid}-daily">{t.daily.heading}</h3>
      <label class="check">
        <input type="checkbox" bind:checked={dailyEnabled} onchange={() => queue({ dailyNotes: { enabled: dailyEnabled } })} />
        <span>{t.daily.enabled}</span>
      </label>
      <div class="field">
        <label class="field-label" for="{uid}-f5">{t.daily.folder}</label>
        <input
          id="{uid}-f5"
          class="text-input"
          list="{uid}-folders"
          autocomplete="off"
          spellcheck="false"
          bind:value={dailyFolder}
          oninput={() => queue({ dailyNotes: { folder: dailyFolder.trim() } })}
        />
      </div>
      <div class="field">
        <label class="field-label" for="{uid}-f6">{t.daily.format}</label>
        <input
          id="{uid}-f6"
          aria-describedby="{uid}-h6"
          class="text-input"
          autocomplete="off"
          spellcheck="false"
          bind:value={dailyFormat}
          oninput={() => {
            // An empty format would name the note ".md".
            if (dailyFormat.trim()) queue({ dailyNotes: { format: dailyFormat.trim() } });
          }}
        />
        <span class="field-hint" id="{uid}-h6">{t.daily.formatHint}{#if dailyPreview} {t.daily.preview(dailyPreview)}{/if}</span>
      </div>
      <div class="field">
        <label class="field-label" for="{uid}-f7">{t.daily.template}</label>
        <input
          id="{uid}-f7"
          aria-describedby="{uid}-h7"
          class="text-input"
          autocomplete="off"
          spellcheck="false"
          bind:value={dailyTemplate}
          oninput={() => queue({ dailyNotes: { template: dailyTemplate.trim() } })}
        />
        <span class="field-hint" id="{uid}-h7">{t.daily.templateHint}</span>
      </div>
    </section>

    <section aria-labelledby="{uid}-appearance">
      <h3 id="{uid}-appearance">{t.appearance.heading}</h3>
      <div class="field">
        <label class="field-label" for="{uid}-f8">{t.appearance.theme}</label>
        <select id="{uid}-f8" class="text-input" value={$theme} onchange={(e) => setTheme(e.currentTarget.value as ThemePreference)}>
          {#each THEMES as v (v)}<option value={v}>{messages.theme[v]}</option>{/each}
        </select>
      </div>
    </section>

    <PasskeyList />
    <SessionList />
  {:else}
    <p class="loading">{messages.loading}</p>
  {/if}
      </div>

<style>
  .settings {
    max-width: 720px;
    margin: 0 auto;
    padding: var(--size-6);
    display: grid;
    gap: var(--size-7, 28px);
  }
  header {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--size-4);
  }
  h2 {
    margin: 0;
    font-size: var(--font-ui-large, 1.25rem);
  }
  .settings > :global(section) {
    display: grid;
    gap: var(--size-4);
  }
  .status {
    margin: 0;
    min-height: 1.2em;
    color: var(--text-faint);
    font-size: var(--font-ui-small);
  }
  .check {
    display: flex;
    gap: var(--size-3);
    align-items: center;
    font-size: var(--font-ui-small);
  }
  .loading {
    color: var(--text-faint);
  }
  section h3 {
    margin: 0;
    font-size: var(--font-ui-medium);
  }
</style>

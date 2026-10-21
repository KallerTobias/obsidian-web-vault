<script lang="ts">
  import {
    LANGUAGES,
    browserLanguages,
    getLanguagePreference,
    resolveLanguage,
    setLanguagePreference,
    t,
    type LanguagePreference,
  } from '../lib/i18n';

  /**
   * UI language of this device. Choosing one stores it and reloads the page (after pending saves).
   * `id`: for an outside `<label for>`; without it the select labels itself (login/setup corner).
   */
  let { id, describedby }: { id?: string; describedby?: string } = $props();

  /** The language `auto` would pick here, by its native name. */
  const autoName = LANGUAGES.find((l) => l.code === resolveLanguage(null, browserLanguages()))!.name;
  let value = $state<LanguagePreference>(getLanguagePreference());
  let busy = $state(false);

  async function change(): Promise<void> {
    busy = true;
    try {
      await setLanguagePreference(value);
    } finally {
      // reload() only starts the navigation; should the page stay, the select is usable again.
      busy = false;
    }
  }
</script>

<select
  {id}
  class="text-input"
  aria-label={id ? undefined : t.settings.language.label}
  aria-describedby={describedby}
  bind:value
  onchange={change}
  disabled={busy}
>
  <option value="auto">{t.settings.language.auto(autoName)}</option>
  {#each LANGUAGES as l (l.code)}<option value={l.code} lang={l.code}>{l.name}</option>{/each}
</select>

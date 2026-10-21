<script lang="ts">
  import { t } from '../lib/i18n';
  import { cycleTheme, nextTheme, theme } from '../lib/stores/theme';

  const next = $derived(nextTheme($theme));
</script>

<button
  type="button"
  class="icon-button"
  aria-label={t.theme.toggle(t.theme[$theme], t.theme[next])}
  title={t.theme.toggle(t.theme[$theme], t.theme[next])}
  onclick={cycleTheme}
>
  {#if $theme === 'light'}
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
    </svg>
  {:else if $theme === 'dark'}
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />
    </svg>
  {:else}
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <rect x="2" y="3" width="20" height="14" rx="2" />
      <path d="M8 21h8M12 17v4" />
    </svg>
  {/if}
</button>

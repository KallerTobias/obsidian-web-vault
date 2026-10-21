<script lang="ts">
  import { t } from '../lib/i18n';

  /** Shown instead of login/setup when the page is not open under the configured origin (PUBLIC_URL). */
  let { publicOrigin, target = '/' }: { publicOrigin?: string; target?: string } = $props();
  // Only an http(s) origin from the server becomes a link.
  const href = $derived(publicOrigin && /^https?:\/\/[^/]+$/.test(publicOrigin) ? publicOrigin + target : undefined);
</script>

<div class="wrong-origin" role="alert">
  <h2>{t.origin.title}</h2>
  {#if publicOrigin}
    <p>{t.origin.text(publicOrigin)}</p>
    {#if href}<a class="button-primary" {href}>{t.origin.link}</a>{/if}
  {:else}
    <p>{t.errors.wrongOrigin}</p>
  {/if}
</div>

<style>
  .wrong-origin {
    display: grid;
    gap: var(--size-4);
  }
  h2 {
    margin: 0;
    font-size: var(--font-ui-medium);
  }
  p {
    margin: 0;
  }
  a.button-primary {
    text-align: center;
    text-decoration: none;
  }
</style>

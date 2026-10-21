<script lang="ts">
  import { session } from '../lib/stores/session';
  import Login from './Login.svelte';

  /**
   * The session ran out while working: log in again in a modal on top of the app, which stays mounted
   * (no typed text is lost). Open notes save their drafts once `expired` is false again.
   */
  const { state: sessionState, expired } = session;
  let dialog = $state<HTMLDialogElement>();

  $effect(() => {
    const d = dialog;
    if (!d || typeof d.showModal !== 'function') return;
    if ($expired && $sessionState === 'ready' && !d.open) d.showModal();
    else if (!$expired && d.open) d.close();
  });
</script>

<dialog bind:this={dialog} class="expired-dialog" aria-labelledby="login-title" oncancel={(e) => e.preventDefault()}>
  {#if $expired}
    <Login expired onSuccess={() => expired.set(false)} />
  {/if}
</dialog>

<style>
  .expired-dialog {
    padding: 0;
    border: 0;
    background: transparent;
    color: inherit;
  }
  .expired-dialog::backdrop {
    background: var(--background-modifier-cover);
  }
</style>

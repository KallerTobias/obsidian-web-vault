<script lang="ts">
  import { browserSupportsWebAuthn, startRegistration } from '@simplewebauthn/browser';
  import { api } from '../lib/api';
  import { t } from '../lib/i18n';
  import { defaultDeviceName, isOriginError, isWrongOrigin, passkeyErrorMessage } from '../lib/passkey';
  import WrongOrigin from './WrongOrigin.svelte';

  /**
   * `onSuccess`: passkey registered and session started. `onLogin`: user already has a passkey.
   * `publicOrigin`: the app's configured origin; under another one only a pointer there is shown.
   */
  let { onSuccess, onLogin, publicOrigin }: { onSuccess: () => void; onLogin?: () => void; publicOrigin?: string } = $props();

  // The token sits in the fragment (`/setup#<token>`, never sent to the server). Read it once and
  // remove it from the URL right away, so it does not linger in history, bookmarks or screenshots.
  const token = location.hash.slice(1);
  if (location.hash) history.replaceState(history.state, '', location.pathname + location.search);

  const supported = browserSupportsWebAuthn();
  let name = $state(defaultDeviceName(navigator.userAgent));
  let busy = $state(false);
  let error = $state('');
  let originRefused = $state(false);
  const wrongOrigin = $derived(originRefused || isWrongOrigin(publicOrigin));

  async function register(e: SubmitEvent): Promise<void> {
    e.preventDefault();
    if (busy) return;
    busy = true;
    error = '';
    let ok = false;
    try {
      const { options, challengeId } = await api.auth.setupOptions(token);
      const response = await startRegistration({ optionsJSON: options });
      await api.auth.setupVerify(token, challengeId, response, name.trim() || defaultDeviceName(navigator.userAgent));
      ok = true;
    } catch (err) {
      if (isOriginError(err)) originRefused = true;
      error = passkeyErrorMessage(err, 'setup');
    } finally {
      busy = false;
    }
    if (ok) {
      history.replaceState(history.state, '', '/');
      onSuccess();
    }
  }
</script>

<div class="auth-card" role="region" aria-labelledby="setup-title">
  <h1 id="setup-title">{t.setup.title}</h1>

  {#if wrongOrigin}
    <!-- The setup link keeps its token, so it still works at the right address. -->
    <WrongOrigin {publicOrigin} target={token ? `/setup#${token}` : '/'} />
  {:else if !supported}
    <p class="error-message" role="alert">{t.errors.unsupported}</p>
  {:else if !token}
    <p>{t.setup.noToken}</p>
    <p class="field-hint">{t.setup.noTokenHint}</p>
  {:else}
    <p>{t.setup.intro}</p>
    <form class="setup-form" onsubmit={register}>
      <label class="field">
        <span class="field-label">{t.setup.deviceName}</span>
        <input class="text-input" type="text" bind:value={name} maxlength="200" autocomplete="off" required />
        <span class="field-hint">{t.setup.deviceHint}</span>
      </label>
      <button type="submit" class="button-primary" disabled={busy} aria-busy={busy}>
        {busy ? t.setup.busy : t.setup.button}
      </button>
    </form>
  {/if}

  {#if error && !wrongOrigin}
    <p class="error-message" role="alert">{error}</p>
  {/if}

  {#if onLogin && !wrongOrigin}
    <button type="button" class="link-button" onclick={onLogin}>{t.setup.toLogin}</button>
  {/if}
</div>

<style>
  .setup-form {
    display: grid;
    gap: var(--size-5);
  }
</style>

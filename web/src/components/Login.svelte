<script lang="ts">
  import {
    WebAuthnAbortService,
    browserSupportsWebAuthn,
    browserSupportsWebAuthnAutofill,
    startAuthentication,
  } from '@simplewebauthn/browser';
  import { onMount } from 'svelte';
  import { api } from '../lib/api';
  import { de } from '../lib/i18n/de';
  import { isCancellation, isOriginError, isWrongOrigin, passkeyErrorMessage } from '../lib/passkey';
  import WrongOrigin from './WrongOrigin.svelte';

  /**
   * `expired`: shown over the app after the session ran out (texts differ, the app stays below).
   * `publicOrigin`: the app's configured origin; under another one only a pointer there is shown.
   */
  let { onSuccess, expired = false, publicOrigin }: { onSuccess: () => void; expired?: boolean; publicOrigin?: string } =
    $props();

  let busy = $state(false);
  let error = $state('');
  /** Set by the server's Origin refusal too (e.g. when the state did not tell). */
  let originRefused = $state(false);
  const wrongOrigin = $derived(originRefused || isWrongOrigin(publicOrigin));
  let destroyed = false;
  const supported = browserSupportsWebAuthn();

  /**
   * Conditional UI: the browser offers passkeys in the autofill of the input below. Purely an
   * extra: every failure is ignored, the button keeps working (starting it aborts this request).
   */
  async function armAutofill(): Promise<void> {
    if (destroyed || !supported || wrongOrigin || !(await browserSupportsWebAuthnAutofill())) return;
    /** True once the user picked a passkey from the autofill: from then on errors are reported. */
    let picked = false;
    try {
      const { options, challengeId } = await api.auth.loginOptions();
      if (destroyed || busy) return;
      const response = await startAuthentication({ optionsJSON: options, useBrowserAutofill: true });
      picked = true;
      busy = true;
      error = '';
      await api.auth.loginVerify(challengeId, response);
      busy = false;
      onSuccess();
    } catch (err) {
      // Before a pick: aborted by the button flow, dismissed or unsupported – nothing to report.
      if (!picked) return;
      busy = false;
      if (!isCancellation(err)) error = passkeyErrorMessage(err, 'login');
      void armAutofill();
    }
  }

  async function login(): Promise<void> {
    if (busy) return;
    busy = true;
    error = '';
    let ok = false;
    try {
      const { options, challengeId } = await api.auth.loginOptions();
      // Starts a new ceremony, which aborts a pending autofill request.
      const response = await startAuthentication({ optionsJSON: options });
      await api.auth.loginVerify(challengeId, response);
      ok = true;
    } catch (err) {
      if (isOriginError(err)) originRefused = true;
      error = passkeyErrorMessage(err, 'login');
    } finally {
      busy = false;
    }
    if (ok) onSuccess();
    else void armAutofill();
  }

  onMount(() => {
    void armAutofill();
    return () => {
      destroyed = true;
      WebAuthnAbortService.cancelCeremony();
    };
  });
</script>

<div class="auth-card" role="region" aria-labelledby="login-title">
  <h1 id="login-title">{expired ? de.login.expiredTitle : de.login.title}</h1>
  <p>{expired ? de.login.expiredIntro : de.login.intro}</p>

  {#if wrongOrigin}
    <WrongOrigin {publicOrigin} />
  {:else if !supported}
    <p class="error-message" role="alert">{de.errors.unsupported}</p>
  {:else}
    <button type="button" class="button-primary" onclick={login} disabled={busy} aria-busy={busy}>
      {busy ? de.login.busy : de.login.button}
    </button>

    <label class="field">
      <span class="field-label">{de.login.autofillLabel}</span>
      <input
        class="text-input"
        type="text"
        name="username"
        autocomplete="username webauthn"
        placeholder={de.login.autofillPlaceholder}
        readonly={busy}
      />
    </label>

    {#if error}
      <p class="error-message" role="alert">{error}</p>
    {/if}
  {/if}
</div>

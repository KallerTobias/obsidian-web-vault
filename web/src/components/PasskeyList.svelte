<script lang="ts">
  import { browserSupportsWebAuthn, startAuthentication, startRegistration } from '@simplewebauthn/browser';
  import { onMount } from 'svelte';
  import { ApiError, api, type PasskeyInfo } from '../lib/api';
  import { formatDateTime } from '../lib/format';
  import { t as messages } from '../lib/i18n';
  import { defaultDeviceName, isCancellation, passkeyErrorMessage } from '../lib/passkey';

  /** Settings section: the account's passkeys (rename, remove) and adding one for this device. */
  const t = messages.settings.passkeys;

  let list = $state<PasskeyInfo[] | null>(null);
  let loadFailed = $state(false);
  let error = $state('');
  let renaming = $state<{ id: string; name: string } | null>(null);
  let newName = $state(defaultDeviceName(navigator.userAgent));
  /** Adding a passkey: first `confirming` with an existing one (step-up), then `registering` the new one. */
  let phase = $state<'idle' | 'confirming' | 'registering'>('idle');
  const adding = $derived(phase !== 'idle');
  let busyId = $state<string | null>(null);
  const supported = browserSupportsWebAuthn();

  async function load(): Promise<void> {
    try {
      list = await api.auth.passkeys.list();
      loadFailed = false;
    } catch {
      loadFailed = true;
    }
  }

  onMount(() => void load());

  const fail = (err: unknown) => (error = t.failed(err instanceof Error ? err.message : String(err)));

  async function saveRename(e: SubmitEvent): Promise<void> {
    e.preventDefault();
    if (!renaming) return;
    const name = renaming.name.trim();
    if (!name) return;
    error = '';
    busyId = renaming.id;
    try {
      await api.auth.passkeys.rename(renaming.id, name);
      renaming = null;
      await load();
    } catch (err) {
      fail(err);
    } finally {
      busyId = null;
    }
  }

  async function remove(p: PasskeyInfo): Promise<void> {
    error = '';
    const last = (list?.length ?? 0) <= 1;
    if (!confirm(last ? t.removeLastConfirm(p.name) : t.removeConfirm(p.name))) return;
    busyId = p.id;
    try {
      try {
        await api.auth.passkeys.remove(p.id, last);
      } catch (err) {
        // The list was stale and this is the last one after all: ask once more, then force.
        if (!(err instanceof ApiError && err.status === 409) || last || !confirm(t.removeLastConfirm(p.name))) throw err;
        await api.auth.passkeys.remove(p.id, true);
      }
      await load();
    } catch (err) {
      fail(err);
    } finally {
      busyId = null;
    }
  }

  async function add(e: SubmitEvent): Promise<void> {
    e.preventDefault();
    if (adding) return;
    phase = 'confirming';
    error = '';
    try {
      // Step-up: prove possession of an existing passkey (with user verification) in this session.
      const confirm = await api.auth.passkeys.confirmOptions();
      const assertion = await startAuthentication({ optionsJSON: confirm.options });
      await api.auth.passkeys.confirm(confirm.challengeId, assertion);
      phase = 'registering';
      const { options, challengeId } = await api.auth.passkeys.options();
      const response = await startRegistration({ optionsJSON: options });
      await api.auth.passkeys.add(challengeId, response, newName.trim() || defaultDeviceName(navigator.userAgent));
      await load();
    } catch (err) {
      // Dismissing the browser's dialog is not an error worth a message.
      if (!isCancellation(err)) error = passkeyErrorMessage(err, 'add');
    } finally {
      phase = 'idle';
    }
  }
</script>

<section class="passkeys" aria-labelledby="settings-passkeys">
  <h3 id="settings-passkeys">{t.heading}</h3>

  {#if loadFailed}
    <p class="error-message" role="alert">{t.loadFailed}</p>
  {:else if list}
    <ul class="items">
      {#each list as p (p.id)}
        <li>
          {#if renaming?.id === p.id}
            <form class="row" onsubmit={saveRename}>
              <input
                class="text-input"
                bind:value={renaming.name}
                maxlength="200"
                aria-label={t.renameLabel(p.name)}
                autocomplete="off"
              />
              <button type="submit" class="button-primary" disabled={busyId === p.id}>{t.save}</button>
              <button type="button" class="link-button" onclick={() => (renaming = null)}>{t.cancel}</button>
            </form>
          {:else}
            <div class="row">
              <div class="info">
                <span class="name">{p.name}</span>
                <span class="meta">
                  {t.created(formatDateTime(p.createdAt))} · {p.lastUsed ? t.lastUsed(formatDateTime(p.lastUsed)) : t.neverUsed}
                </span>
              </div>
              <button type="button" class="link-button" onclick={() => (renaming = { id: p.id, name: p.name })} aria-label="{t.rename}: {p.name}">
                {t.rename}
              </button>
              <button type="button" class="link-button danger" onclick={() => remove(p)} disabled={busyId === p.id} aria-label="{t.remove}: {p.name}">
                {t.remove}
              </button>
            </div>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}

  {#if supported}
    <form class="add" onsubmit={add}>
      <label class="field">
        <span class="field-label">{t.deviceName}</span>
        <input class="text-input" bind:value={newName} maxlength="200" autocomplete="off" />
      </label>
      <button type="submit" class="button-primary" disabled={adding} aria-busy={adding}>{t.add}</button>
    </form>
    <p class="field-hint" role="status">
      {phase === 'confirming' ? t.confirming : phase === 'registering' ? t.adding : t.addHint}
    </p>
  {:else}
    <p class="error-message" role="alert">{messages.errors.unsupported}</p>
  {/if}

  {#if error}<p class="error-message" role="alert">{error}</p>{/if}
</section>

<style>
  h3 {
    margin: 0 0 var(--size-3);
    font-size: var(--font-ui-medium);
  }
  .items {
    list-style: none;
    margin: 0 0 var(--size-5);
    padding: 0;
    display: grid;
    gap: var(--size-3);
  }
  .row {
    display: flex;
    align-items: center;
    gap: var(--size-4);
    flex-wrap: wrap;
  }
  .info {
    display: grid;
    flex: 1;
    min-width: 12em;
  }
  .meta {
    color: var(--text-faint);
    font-size: var(--font-ui-smaller);
  }
  .danger {
    color: var(--text-error);
  }
  .add {
    display: flex;
    align-items: flex-end;
    gap: var(--size-4);
    flex-wrap: wrap;
  }
  .add .field {
    flex: 1;
    min-width: 12em;
  }
  .button-primary {
    width: auto;
  }
</style>

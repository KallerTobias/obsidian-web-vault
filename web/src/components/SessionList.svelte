<script lang="ts">
  import { onMount } from 'svelte';
  import { api, type SessionInfo } from '../lib/api';
  import { formatDateTime } from '../lib/format';
  import { de } from '../lib/i18n/de';
  import { defaultDeviceName } from '../lib/passkey';

  /**
   * Settings section: signed-in browsers. The current session is marked and cannot be ended here
   * (that is what "Abmelden" is for); the others can be ended one by one or all at once.
   */
  const t = de.settings.sessions;

  let list = $state<SessionInfo[] | null>(null);
  let loadFailed = $state(false);
  let error = $state('');
  let busy = $state(false);

  const others = $derived((list ?? []).filter((s) => !s.current));

  async function load(): Promise<void> {
    try {
      list = await api.auth.sessions.list();
      loadFailed = false;
    } catch {
      loadFailed = true;
    }
  }

  onMount(() => void load());

  const label = (s: SessionInfo) => (s.userAgent ? defaultDeviceName(s.userAgent) : t.unknownDevice);

  async function run(action: () => Promise<void>): Promise<void> {
    if (busy) return;
    busy = true;
    error = '';
    try {
      await action();
      await load();
    } catch (err) {
      error = t.failed(err instanceof Error ? err.message : String(err));
    } finally {
      busy = false;
    }
  }

  const revoke = (s: SessionInfo) => run(() => api.auth.sessions.revoke(s.id));

  async function revokeOthers(): Promise<void> {
    if (!confirm(t.revokeOthersConfirm)) return;
    await run(() => api.auth.sessions.revokeOthers());
  }
</script>

<section aria-labelledby="settings-sessions">
  <h3 id="settings-sessions">{t.heading}</h3>

  {#if loadFailed}
    <p class="error-message" role="alert">{t.loadFailed}</p>
  {:else if list}
    <ul class="items">
      {#each list as s (s.id)}
        <li class="row">
          <div class="info">
            <span class="name">{label(s)}{#if s.current} <span class="current">{t.current}</span>{/if}</span>
            <span class="meta">{[s.ip, t.lastSeen(formatDateTime(s.lastSeen))].filter(Boolean).join(' · ')}</span>
          </div>
          {#if !s.current}
            <button type="button" class="link-button" onclick={() => revoke(s)} disabled={busy} aria-label={t.revokeLabel(label(s))}>
              {t.revoke}
            </button>
          {/if}
        </li>
      {/each}
    </ul>
    <p class="meta">{t.currentHint}</p>
    <button type="button" class="button-primary" onclick={revokeOthers} disabled={busy || others.length === 0}>
      {t.revokeOthers}
    </button>
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
    margin: 0 0 var(--size-4);
    padding: 0;
    display: grid;
    gap: var(--size-3);
  }
  .row {
    display: flex;
    align-items: center;
    gap: var(--size-4);
  }
  .info {
    display: grid;
    flex: 1;
    min-width: 0;
  }
  .current {
    color: var(--text-accent);
    font-size: var(--font-ui-smaller);
  }
  .meta {
    color: var(--text-faint);
    font-size: var(--font-ui-smaller);
    overflow-wrap: anywhere;
  }
  p.meta {
    margin: 0 0 var(--size-4);
  }
  .button-primary {
    width: auto;
  }
</style>

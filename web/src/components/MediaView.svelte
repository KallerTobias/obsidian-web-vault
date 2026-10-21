<script lang="ts">
  import { basename } from '@shared/normalize';
  import { api } from '../lib/api';
  import { t } from '../lib/i18n';
  import { mediaKind } from '../lib/media';

  /** Shows a non-note file from the vault: image, PDF, audio, video; anything else as download. */
  let { path }: { path: string } = $props();

  const kind = $derived(mediaKind(path));
  const src = $derived(api.file.url(path));
  const name = $derived(basename(path));
</script>

<div class="media" class:fill={kind === 'pdf'}>
  {#if kind === 'image'}
    <img {src} alt={name} />
  {:else if kind === 'pdf'}
    <iframe {src} title={name}></iframe>
  {:else if kind === 'audio'}
    <audio {src} controls preload="metadata" aria-label={name}></audio>
  {:else if kind === 'video'}
    <!-- Personal media without caption tracks. -->
    <!-- svelte-ignore a11y_media_has_caption -->
    <video {src} controls preload="metadata" aria-label={name}></video>
  {:else}
    <p class="hint">{t.media.unsupported}</p>
  {/if}
  <p class="actions">
    {#if kind === 'pdf'}<a href={src} target="_blank" rel="noopener">{t.media.openPdf}</a> · {/if}
    <a href={src} download={name}>{t.media.download}</a>
  </p>
</div>

<style>
  .media {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--size-4);
    padding: var(--size-6);
    min-height: 100%;
  }
  .media.fill {
    height: 100%;
    padding: 0;
    gap: 0;
  }
  img,
  video {
    max-width: 100%;
    max-height: calc(100vh - 160px);
    object-fit: contain;
  }
  audio {
    width: min(480px, 100%);
  }
  iframe {
    flex: 1;
    width: 100%;
    border: 0;
  }
  .hint {
    color: var(--text-faint);
  }
  .actions {
    margin: 0;
    padding: var(--size-3);
    font-size: var(--font-ui-small);
    color: var(--text-faint);
  }
  a {
    color: var(--text-accent);
  }
</style>

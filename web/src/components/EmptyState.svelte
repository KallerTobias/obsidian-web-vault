<script lang="ts">
  import { basename } from '@shared/normalize';
  import { de } from '../lib/i18n/de';
  import { workspace } from '../lib/stores/workspace';

  /** Main area without tabs: a hint and the recently opened files. */
  const recent = $derived($workspace.recent.slice(0, 8));
</script>

<div class="empty-state">
  <h2>{de.emptyState.title}</h2>
  <p>{de.emptyState.hint}</p>
  {#if recent.length}
    <h3>{de.emptyState.recent}</h3>
    <ul>
      {#each recent as path (path)}
        <li>
          <button type="button" class="link-button" title={path} onclick={() => workspace.open(path)}>
            {basename(path).replace(/\.md$/i, '')}
          </button>
        </li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  .empty-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: var(--size-2);
    height: 100%;
    padding: var(--size-6);
    color: var(--text-muted);
    text-align: center;
  }
  h2 {
    margin: 0;
    font-size: var(--font-ui-medium);
    color: var(--text-normal);
  }
  p {
    margin: 0 0 var(--size-4);
    font-size: var(--font-ui-small);
  }
  h3 {
    margin: var(--size-4) 0 var(--size-2);
    font-size: var(--font-ui-smaller);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--text-faint);
  }
  ul {
    margin: 0;
    padding: 0;
    list-style: none;
  }
  li {
    margin: var(--size-2) 0;
  }
</style>

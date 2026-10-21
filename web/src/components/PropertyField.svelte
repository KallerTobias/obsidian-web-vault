<script lang="ts">
  import { t } from '../lib/i18n';
  import { addListItems, DATETIME_RE, inferPropertyType, listValue } from '../lib/properties';

  /**
   * One frontmatter property: its name (renamable) and a value editor chosen by type. Values are committed
   * on blur/Enter (text, number), on change (checkbox, date) or per chip (lists, tags). `onSet` gets a
   * function of the CURRENT value, so list edits build on the latest text.
   */
  let {
    name,
    value,
    readonly,
    onRename,
    onSet,
    onRemove,
  }: {
    name: string;
    value: unknown;
    readonly: boolean;
    /** Returns false when the rename was refused (the input then shows the old name again). */
    onRename: (to: string) => boolean;
    onSet: (fn: (current: unknown) => unknown) => void;
    onRemove: () => void;
  } = $props();

  const type = $derived(inferPropertyType(name, value));
  /** Maps and lists of maps are not edited here (they would be flattened to text). */
  const nested = $derived(
    typeof value === 'object' && value !== null && !(value instanceof Date) && (!Array.isArray(value) || value.some((v) => typeof v === 'object' && v !== null)),
  );
  const isTags = $derived(type === 'tags');
  const items = $derived(type === 'list' || type === 'tags' ? listValue(value, isTags) : []);
  const label = $derived(t.properties.valueLabel(name));
  const asText = (v: unknown) => (v == null ? '' : v instanceof Date ? v.toISOString() : String(v));

  function commitKey(el: HTMLInputElement): void {
    const to = el.value.trim();
    if (to === name) return;
    if (!onRename(to)) el.value = name;
  }

  function commitText(el: HTMLInputElement): void {
    if (el.value === asText(value)) return;
    const v = el.value;
    onSet(() => v);
  }

  function commitNumber(el: HTMLInputElement): void {
    // Unreadable input reads as '' — that is no reason to clear the value.
    if (el.validity.badInput) {
      el.value = asText(value);
      return;
    }
    if (el.value === asText(value)) return;
    if (el.value.trim() === '') return onSet(() => null);
    const n = Number(el.value);
    if (Number.isFinite(n)) onSet(() => n);
    else el.value = asText(value);
  }

  /** `YYYY-MM-DDTHH:MM[:SS]` for the picker; the zone (`Z`, `+02:00`) is kept aside and written back. */
  const dateTime = $derived.by(() => {
    const s = asText(value);
    const m = DATETIME_RE.exec(s);
    if (!m) return { local: '', zone: '' };
    const zone = m[4] ?? '';
    return { local: s.slice(0, s.length - zone.length).replace(' ', 'T').replace(/\.\d+$/, ''), zone };
  });

  /** Pickers normalise their value (`09:30:00` reads back as `09:30`): compare with what was shown on focus. */
  function rememberShown(el: HTMLInputElement): void {
    el.dataset.original = el.value;
  }

  function commitDate(el: HTMLInputElement, original: string, suffix = ''): void {
    if (el.value === (el.dataset.original ?? original)) return;
    const v = el.value === '' ? null : el.value + suffix;
    onSet(() => v);
  }

  function enterBlurs(e: KeyboardEvent): void {
    const el = e.currentTarget as HTMLInputElement;
    if (e.key === 'Enter') {
      e.preventDefault();
      el.blur();
    } else if (e.key === 'Escape') {
      el.value = el.dataset.original ?? '';
      el.blur();
    }
  }

  function addItems(el: HTMLInputElement): void {
    const text = el.value;
    el.value = '';
    if (text.trim() === '') return;
    const tags = isTags;
    onSet((cur) => addListItems(listValue(cur, tags), text, tags));
  }

  function listKey(e: KeyboardEvent): void {
    const el = e.currentTarget as HTMLInputElement;
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      addItems(el);
    } else if (e.key === 'Backspace' && el.value === '' && items.length > 0) {
      e.preventDefault();
      const tags = isTags;
      onSet((cur) => listValue(cur, tags).slice(0, -1));
    }
  }

  function removeItem(item: string): void {
    const tags = isTags;
    onSet((cur) => listValue(cur, tags).filter((x) => x !== item));
  }
</script>

<div class="property">
  <input
    class="key"
    type="text"
    value={name}
    data-original={name}
    aria-label={t.properties.keyLabel}
    disabled={readonly}
    spellcheck="false"
    onblur={(e) => commitKey(e.currentTarget)}
    onkeydown={enterBlurs}
  />
  <div class="value">
    {#if nested}
      <span class="nested" title={t.properties.nested}>{JSON.stringify(value)}</span>
    {:else if type === 'checkbox'}
      <input type="checkbox" checked={value === true} aria-label={label} disabled={readonly} onchange={(e) => {
        const checked = e.currentTarget.checked;
        onSet(() => checked);
      }} />
    {:else if type === 'number'}
      <input type="number" step="any" value={asText(value)} data-original={asText(value)} aria-label={label} disabled={readonly}
        onblur={(e) => commitNumber(e.currentTarget)} onkeydown={enterBlurs} />
    {:else if type === 'date'}
      <input type="date" value={asText(value)} data-original={asText(value)} aria-label={label} disabled={readonly}
        onfocus={(e) => rememberShown(e.currentTarget)} onblur={(e) => commitDate(e.currentTarget, asText(value))} onkeydown={enterBlurs} />
    {:else if type === 'datetime'}
      <input type="datetime-local" step="1" value={dateTime.local} data-original={dateTime.local} aria-label={label} disabled={readonly}
        onfocus={(e) => rememberShown(e.currentTarget)} onblur={(e) => commitDate(e.currentTarget, dateTime.local, dateTime.zone)} onkeydown={enterBlurs} />
    {:else if type === 'list' || type === 'tags'}
      <div class="chips">
        {#each items as item (item)}
          <span class="chip" class:tag={isTags}>
            {isTags ? `#${item}` : item}
            {#if !readonly}
              <button type="button" class="chip-remove" aria-label={t.properties.removeItem(item)} onclick={() => removeItem(item)}>×</button>
            {/if}
          </span>
        {/each}
        {#if !readonly}
          <input class="chip-input" type="text" placeholder={t.properties.addItem} aria-label={label}
            onkeydown={listKey} onblur={(e) => addItems(e.currentTarget)} />
        {/if}
      </div>
    {:else}
      <input type="text" value={asText(value)} data-original={asText(value)} aria-label={label} disabled={readonly}
        onblur={(e) => commitText(e.currentTarget)} onkeydown={enterBlurs} />
    {/if}
  </div>
  {#if !readonly}
    <button type="button" class="icon-button remove" aria-label={t.properties.remove(name)} title={t.properties.remove(name)} onclick={onRemove}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
    </button>
  {/if}
</div>

<style>
  .property {
    display: grid;
    grid-template-columns: minmax(70px, 35%) minmax(0, 1fr) auto;
    align-items: start;
    gap: var(--size-2);
    padding: 2px 0;
  }
  input[type='text'],
  input[type='number'],
  input[type='date'],
  input[type='datetime-local'] {
    width: 100%;
    min-width: 0;
    box-sizing: border-box;
    padding: 2px var(--size-2);
    border: 1px solid transparent;
    border-radius: var(--radius-s, 4px);
    background: transparent;
    color: var(--text-normal);
    font: inherit;
    font-size: var(--font-ui-small);
  }
  input:hover:not(:disabled),
  input:focus {
    border-color: var(--background-modifier-border);
    background: var(--background-primary);
  }
  .key {
    color: var(--text-muted);
  }
  .value {
    min-width: 0;
  }
  .nested {
    display: block;
    padding: 2px var(--size-2);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--text-faint);
    font-size: var(--font-ui-small);
  }
  .chips {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px;
  }
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 2px;
    padding: 0 6px;
    border-radius: 999px;
    background: var(--background-modifier-hover);
    font-size: var(--font-ui-smaller);
  }
  .chip.tag {
    color: var(--text-accent);
  }
  .chip-remove {
    border: 0;
    padding: 0 2px;
    background: none;
    color: var(--text-faint);
    cursor: pointer;
    font: inherit;
  }
  .chip-input {
    flex: 1;
    min-width: 60px;
  }
  .remove {
    opacity: 0.4;
  }
  .property:hover .remove,
  .remove:focus-visible {
    opacity: 1;
  }
</style>

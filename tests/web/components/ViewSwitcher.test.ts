/// <reference lib="dom" />
/// <reference types="svelte" />
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ViewSwitcher from '../../../web/src/components/ViewSwitcher.svelte';

afterEach(cleanup);

describe('ViewSwitcher', () => {
  it('has a Graph button next to the view tabs that only triggers the graph action', async () => {
    const onSelect = vi.fn();
    const onGraph = vi.fn();
    render(ViewSwitcher, { view: 'files', onSelect, onGraph });
    const button = screen.getByRole('button', { name: 'Graph öffnen' });
    expect(button.getAttribute('title')).toBe('Graph öffnen');
    expect(screen.getAllByRole('tab').map((t) => t.getAttribute('aria-label'))).toEqual(['Dateien', 'Suche', 'Tags']);
    await fireEvent.click(button);
    expect(onGraph).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('selects views through the tabs', async () => {
    const onSelect = vi.fn();
    render(ViewSwitcher, { view: 'files', onSelect, onGraph: vi.fn() });
    expect(screen.getByRole('tab', { name: 'Dateien' }).getAttribute('aria-selected')).toBe('true');
    await fireEvent.click(screen.getByRole('tab', { name: 'Tags' }));
    expect(onSelect).toHaveBeenCalledWith('tags');
  });
});

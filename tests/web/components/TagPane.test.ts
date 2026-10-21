/// <reference lib="dom" />
/// <reference types="svelte" />
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import TagPane from '../../../web/src/components/TagPane.svelte';

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json([
        { tag: 'projekt', count: 2 },
        { tag: 'projekt/alpha', count: 3 },
        { tag: 'privat', count: 1 },
      ]),
    ),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('TagPane', () => {
  it('shows a collapsible tree with summed counts and remembers what is open', async () => {
    const { unmount } = render(TagPane, { onSelect: vi.fn() });
    expect(await screen.findByRole('button', { name: '#projekt, 5' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /#projekt\/alpha/ })).toBeNull();
    await fireEvent.click(screen.getByRole('button', { name: 'Aufklappen: projekt' }));
    expect(screen.getByRole('button', { name: '#projekt/alpha, 3' })).toBeTruthy();
    unmount();
    render(TagPane, { onSelect: vi.fn() });
    expect(await screen.findByRole('button', { name: '#projekt/alpha, 3' })).toBeTruthy();
  });

  it('selects the full tag', async () => {
    const onSelect = vi.fn();
    render(TagPane, { onSelect });
    await fireEvent.click(await screen.findByRole('button', { name: '#privat, 1' }));
    expect(onSelect).toHaveBeenCalledWith('privat');
  });
});

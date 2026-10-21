/// <reference lib="dom" />
/// <reference types="svelte" />
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import SearchPane from '../../../web/src/components/SearchPane.svelte';
import { segments } from '../../../web/src/lib/highlight';

let urls: string[];
let responses: Map<string, () => Promise<Response>>;

beforeEach(() => {
  vi.useFakeTimers();
  urls = [];
  responses = new Map();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      urls.push(url);
      const q = new URL(url, 'http://x').searchParams.get('q')!;
      return (responses.get(q) ?? (async () => Response.json([])))();
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const hit = (path: string, line: number, text: string, ranges: [number, number][]) => ({
  path,
  score: 1,
  matches: [{ line, text, ranges }],
});

describe('segments', () => {
  it('splits at ranges and clamps', () => {
    expect(segments('ab cd ef', [[3, 5], [7, 99]])).toEqual([
      { text: 'ab ', mark: false },
      { text: 'cd', mark: true },
      { text: ' e', mark: false },
      { text: 'f', mark: true },
    ]);
    expect(segments('x', [])).toEqual([{ text: 'x', mark: false }]);
  });
});

describe('SearchPane', () => {
  it('debounces, highlights with <mark> and opens at the line', async () => {
    responses.set('plan', async () => Response.json([hit('Projekte/Plan.md', 4, 'Der <b>Plan</b> steht', [[7, 11]])]));
    const onOpen = vi.fn();
    render(SearchPane, { onOpen });
    const input = screen.getByLabelText('Suche im Vault');
    await fireEvent.input(input, { target: { value: 'pl' } });
    await fireEvent.input(input, { target: { value: 'plan' } });
    await vi.advanceTimersByTimeAsync(249);
    expect(urls).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(urls).toEqual(['/api/search?q=plan&limit=100']);
    expect(await screen.findByText('1 Notiz')).toBeTruthy();
    const marks = document.querySelectorAll('mark');
    expect([...marks].map((m) => m.textContent)).toEqual(['Plan']);
    // Note text is never parsed as HTML.
    expect(document.querySelector('.text b')).toBeNull();
    expect(document.querySelector('.text')!.textContent).toBe('Der <b>Plan</b> steht');

    await fireEvent.click(screen.getByRole('button', { name: 'Plan, Zeile 5' }));
    expect(onOpen).toHaveBeenCalledWith('Projekte/Plan.md', { newTab: false, line: 4 });
  });

  it('drops answers to outdated queries', async () => {
    let releaseOld!: () => void;
    responses.set('alt', () => new Promise((r) => (releaseOld = () => r(Response.json([hit('Alt.md', 0, 'alt', [[0, 3]])])))));
    responses.set('neu', async () => Response.json([hit('Neu.md', 0, 'neu', [[0, 3]])]));
    render(SearchPane, { onOpen: vi.fn() });
    const input = screen.getByLabelText('Suche im Vault');
    await fireEvent.input(input, { target: { value: 'alt' } });
    await vi.advanceTimersByTimeAsync(250);
    await fireEvent.input(input, { target: { value: 'neu' } });
    await vi.advanceTimersByTimeAsync(250);
    releaseOld();
    await vi.advanceTimersByTimeAsync(0);
    expect(screen.queryByText('Alt')).toBeNull();
    expect(screen.getByText('Neu')).toBeTruthy();
  });

  it('says when nothing matches and clears for an empty query', async () => {
    render(SearchPane, { onOpen: vi.fn() });
    const input = screen.getByLabelText('Suche im Vault');
    await fireEvent.input(input, { target: { value: 'nichts' } });
    await vi.advanceTimersByTimeAsync(250);
    expect(await screen.findByText('Keine Treffer')).toBeTruthy();
    await fireEvent.input(input, { target: { value: '' } });
    expect(screen.queryByText('Keine Treffer')).toBeNull();
  });
});

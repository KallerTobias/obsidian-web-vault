/// <reference lib="dom" />
/// <reference types="svelte" />
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import CommandPalette from '../../../web/src/components/CommandPalette.svelte';
import QuickSwitcher from '../../../web/src/components/QuickSwitcher.svelte';
import { registerCommandActions } from '../../../web/src/lib/commands';
import { vault } from '../../../web/src/lib/stores/vault';

let calls: { url: string; method: string; body?: unknown }[];

beforeEach(() => {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      calls.push({ url, method: init.method ?? 'GET', body: init.body ? JSON.parse(String(init.body)) : undefined });
      if (url === '/api/settings') return Response.json({ newNoteFolder: 'Neu' });
      if (url === '/api/note' && init.method === 'POST') return Response.json({ path: 'Neu/Idee.md', version: 'v' });
      return Response.json([
        { path: 'Projekte/Plan.md', name: 'Plan', aliases: ['Vorhaben'] },
        { path: '00 - Übersicht.md', name: '00 - Übersicht', aliases: [] },
      ]);
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('QuickSwitcher', () => {
  async function open() {
    await vault.load();
    const onOpen = vi.fn();
    const onClose = vi.fn();
    render(QuickSwitcher, { onOpen, onClose });
    return { onOpen, onClose, input: screen.getByRole('combobox') };
  }

  it('opens the selected note with Enter and in a new tab with Ctrl+Enter', async () => {
    const { onOpen, onClose, input } = await open();
    await fireEvent.input(input, { target: { value: 'ubers' } });
    await fireEvent.keyDown(input, { key: 'Enter' });
    expect(onOpen).toHaveBeenCalledWith('00 - Übersicht.md', { newTab: false });
    expect(onClose).toHaveBeenCalled();
    await fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true });
    expect(onOpen).toHaveBeenLastCalledWith('00 - Übersicht.md', { newTab: true });
  });

  it('finds aliases and moves with the arrow keys', async () => {
    const { onOpen, input } = await open();
    await fireEvent.input(input, { target: { value: 'p' } });
    const options = screen.getAllByRole('option');
    expect(options.length).toBeGreaterThan(1);
    await fireEvent.input(input, { target: { value: 'vorh' } });
    expect(screen.getByRole('option', { name: /Vorhaben/ }).textContent).toContain('Alias von Plan');
    await fireEvent.keyDown(input, { key: 'ArrowDown' });
    await fireEvent.keyDown(input, { key: 'ArrowUp' });
    await fireEvent.keyDown(input, { key: 'Enter' });
    expect(onOpen).toHaveBeenCalledWith('Projekte/Plan.md', { newTab: false });
  });

  it('offers to create the note in the configured folder', async () => {
    const { onOpen, input } = await open();
    await fireEvent.input(input, { target: { value: 'Idee' } });
    const create = screen.getByRole('option', { name: 'Notiz ‚Idee‘ anlegen' });
    await fireEvent.click(create);
    await vi.waitFor(() => expect(onOpen).toHaveBeenCalledWith('Neu/Idee.md', { newTab: false }));
    expect(calls.find((c) => c.url === '/api/note' && c.method === 'POST')!.body).toMatchObject({ path: 'Neu/Idee.md' });
  });

  it('refuses invalid names', async () => {
    const { onOpen, input } = await open();
    await fireEvent.input(input, { target: { value: 'a/b' } });
    await fireEvent.keyDown(input, { key: 'ArrowDown' });
    await fireEvent.click(screen.getByRole('option', { name: /anlegen/ }));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(onOpen).not.toHaveBeenCalled();
  });
});

describe('CommandPalette', () => {
  it('filters and runs a command after closing', async () => {
    const openSearch = vi.fn();
    const off = registerCommandActions({ openSearch });
    const onClose = vi.fn();
    render(CommandPalette, { onClose });
    const input = screen.getByRole('combobox');
    await fireEvent.input(input, { target: { value: 'such' } });
    expect(screen.getAllByRole('option')).toHaveLength(1);
    expect(screen.getByRole('option').textContent).toContain('Umschalt');
    await fireEvent.keyDown(input, { key: 'Enter' });
    await vi.waitFor(() => expect(openSearch).toHaveBeenCalled());
    expect(onClose).toHaveBeenCalled();
    off();
  });

  it('closes with Escape and shows a message without matches', async () => {
    const onClose = vi.fn();
    render(CommandPalette, { onClose });
    const input = screen.getByRole('combobox');
    await fireEvent.input(input, { target: { value: 'qqqq' } });
    expect(screen.getByText('Kein Befehl gefunden')).toBeTruthy();
    await fireEvent.keyDown(input, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });
});

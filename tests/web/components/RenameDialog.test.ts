/// <reference lib="dom" />
/// <reference types="svelte" />
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import RenameDialog from '../../../web/src/components/RenameDialog.svelte';
import { NoteSaver } from '../../../web/src/lib/editor/save';

type Call = { url: string; method: string; body: unknown };
let calls: Call[];
let renameResult: unknown;

beforeEach(() => {
  calls = [];
  renameResult = { moved: [], updated: ['A.md', 'B.md', 'C.md'], skippedReadonly: [], conflicts: [], failed: [] };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      calls.push({ url, method: init.method ?? 'GET', body: init.body ? JSON.parse(String(init.body)) : undefined });
      if (url.startsWith('/api/rename/affected')) return Response.json({ count: 3, paths: ['A.md', 'B.md', 'C.md'] });
      if (url === '/api/rename') return Response.json(renameResult);
      return new Response(null, { status: 404 });
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('RenameDialog', () => {
  it('shows how many notes link here and adjusts links by default', async () => {
    const onDone = vi.fn();
    const onClose = vi.fn();
    render(RenameDialog, { path: 'Ordner/Alt #1.md', kind: 'note', mode: 'rename', onDone, onClose });
    expect(calls[0]!.url).toBe('/api/rename/affected?path=Ordner%2FAlt%20%231.md');
    const box = await screen.findByLabelText('3 Notizen verlinken hierauf – Links anpassen?');
    expect((box as HTMLInputElement).checked).toBe(true);

    const name = screen.getByLabelText('Neuer Name') as HTMLInputElement;
    expect(name.value).toBe('Alt #1');
    await fireEvent.input(name, { target: { value: 'Neu – Ä' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Umbenennen' }));
    await vi.waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(calls.at(-1)).toEqual({
      url: '/api/rename',
      method: 'POST',
      body: { from: 'Ordner/Alt #1.md', to: 'Ordner/Neu – Ä.md', updateLinks: true },
    });
    expect(onDone).toHaveBeenCalledWith('Ordner/Alt #1.md', 'Ordner/Neu – Ä.md', renameResult);
  });

  it('saves pending edits of open notes below the path before renaming', async () => {
    const order: string[] = [];
    const saver = new NoteSaver('Ordner/Alt.md', 'v0', {
      get: async () => ({ content: '', version: 'v0', readonly: false }),
      save: async (path) => {
        order.push(`save ${path}`);
        return { version: 'v1' };
      },
      create: async (path) => ({ path, version: 'v1' }),
    }, localStorage, { content: '' });
    saver.edit('getippt');
    const fetchMock = vi.mocked(fetch);
    const inner = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (url, init) => {
      if (url === '/api/rename') order.push('rename');
      return inner(url, init);
    });
    render(RenameDialog, { path: 'Ordner', kind: 'folder', mode: 'rename', onClose: vi.fn() });
    await screen.findByLabelText(/Links anpassen\?/);
    await fireEvent.input(screen.getByLabelText('Neuer Name'), { target: { value: 'Neu' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Umbenennen' }));
    await vi.waitFor(() => expect(order).toEqual(['save Ordner/Alt.md', 'rename']));
    saver.close();
  });

  it('can leave links alone', async () => {
    render(RenameDialog, { path: 'Alt.md', kind: 'note', mode: 'rename', onClose: vi.fn() });
    await fireEvent.click(await screen.findByLabelText(/Links anpassen\?/));
    await fireEvent.input(screen.getByLabelText('Neuer Name'), { target: { value: 'Neu' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Umbenennen' }));
    await vi.waitFor(() => expect(calls.at(-1)?.body).toEqual({ from: 'Alt.md', to: 'Neu.md', updateLinks: false }));
  });

  it('reports links it could not adjust and stays open', async () => {
    renameResult = { moved: [], updated: ['A.md'], skippedReadonly: ['Archiv/B.md'], conflicts: ['C.md'], failed: [] };
    const onClose = vi.fn();
    render(RenameDialog, { props: { path: 'Alt.md', kind: 'note', mode: 'move', target: 'Ziel', folders: ['', 'Ziel'], onClose } });
    await screen.findByLabelText(/Links anpassen\?/);
    expect((screen.getByLabelText('Zielordner') as HTMLInputElement).value).toBe('Ziel');
    await fireEvent.click(screen.getByRole('button', { name: 'Verschieben' }));
    const status = await screen.findByRole('status');
    expect(status.textContent).toContain('Nicht angepasst (schreibgeschützt):');
    expect(status.textContent).toContain('Archiv/B.md');
    expect(status.textContent).toContain('Nicht angepasst (zwischenzeitlich geändert):');
    expect(status.textContent).toContain('C.md');
    expect(calls.at(-1)?.body).toEqual({ from: 'Alt.md', to: 'Ziel/Alt.md', updateLinks: true });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('moves an entry whose existing name has # (unchanged names are not checked)', async () => {
    const onClose = vi.fn();
    render(RenameDialog, {
      props: { path: 'Projekte/Notiz #1.md', kind: 'note', mode: 'move', target: 'Archiv', folders: ['', 'Archiv'], onClose },
    });
    await screen.findByLabelText(/Links anpassen\?/);
    await fireEvent.click(screen.getByRole('button', { name: 'Verschieben' }));
    await vi.waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(calls.at(-1)?.body).toEqual({ from: 'Projekte/Notiz #1.md', to: 'Archiv/Notiz #1.md', updateLinks: true });
  });

  it('renaming such a name to another one with # is refused', async () => {
    render(RenameDialog, { path: 'Notiz #1.md', kind: 'note', mode: 'rename', onClose: vi.fn() });
    await screen.findByLabelText(/Links anpassen\?/);
    await fireEvent.input(screen.getByLabelText('Neuer Name'), { target: { value: 'Notiz #2' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Umbenennen' }));
    expect(screen.getByRole('alert').textContent).toContain('Der Name darf nicht leer sein');
    expect(calls.some((c) => c.url === '/api/rename')).toBe(false);
  });

  it.each(['a/b', 'a?b', 'a:b', 'Plan #2', 'x|y', '[a]', '.versteckt', ' '])('rejects the name %j (path or wiki-link syntax)', async (bad) => {
    render(RenameDialog, { path: 'Alt.md', kind: 'note', mode: 'rename', onClose: vi.fn() });
    await screen.findByLabelText(/Links anpassen\?/);
    await fireEvent.input(screen.getByLabelText('Neuer Name'), { target: { value: bad } });
    await fireEvent.click(screen.getByRole('button', { name: 'Umbenennen' }));
    expect(screen.getByRole('alert').textContent).toContain('Der Name darf nicht leer sein');
    expect(calls.some((c) => c.url === '/api/rename')).toBe(false);
  });
});

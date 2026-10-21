/// <reference lib="dom" />
/// <reference types="svelte" />
import { cleanup, fireEvent, render, screen, within } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TreeEntry } from '../../../web/src/lib/api';
import { de } from '../../../web/src/lib/i18n/de';
import FileTree from '../../../web/src/components/FileTree.svelte';

const entry = (path: string, kind: TreeEntry['kind'], children?: TreeEntry[]): TreeEntry => ({
  path,
  name: path.split('/').pop()!,
  kind,
  mtime: 0,
  size: 0,
  readonly: false,
  ...(children ? { children } : {}),
});

const root = entry('', 'folder', [
  entry('Ordner – Ä', 'folder', [entry('Ordner – Ä/Unter', 'folder', []), entry('Ordner – Ä/Notiz #1.md', 'note')]),
  entry('Bild.png', 'file'),
  entry('Start.md', 'note'),
]);

let calls: { url: string; method: string }[];

beforeEach(() => {
  localStorage.clear();
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      calls.push({ url, method: init.method ?? 'GET' });
      if (url === '/api/settings') return Response.json({ templatesFolder: '' });
      if (url.startsWith('/api/rename/affected')) return Response.json({ count: 0, paths: [] });
      return new Response(null, { status: 204 });
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const items = () => screen.getAllByRole('treeitem');
const names = () => items().map((el) => el.textContent?.trim());

describe('FileTree', () => {
  it('renders the top level with folders collapsed and notes without .md', () => {
    render(FileTree, { root, onOpen: vi.fn() });
    expect(screen.getByRole('tree')).toBeTruthy();
    expect(names()).toEqual(['Ordner – Ä', expect.stringContaining('Bild.png'), 'Start']);
    expect(items()[0]!.getAttribute('aria-expanded')).toBe('false');
    expect(items()[0]!.getAttribute('aria-level')).toBe('1');
  });

  it('expands a folder on click (and remembers it), opens files with or without a new tab', async () => {
    const onOpen = vi.fn();
    render(FileTree, { root, onOpen });
    await fireEvent.click(screen.getByText('Ordner – Ä'));
    expect(names()).toEqual(['Ordner – Ä', 'Unter', 'Notiz #1', expect.stringContaining('Bild.png'), 'Start']);
    expect(items()[0]!.getAttribute('aria-expanded')).toBe('true');
    expect(items()[2]!.getAttribute('aria-level')).toBe('2');
    expect(JSON.parse(localStorage.getItem('vw.tree.expanded')!)).toEqual(['Ordner – Ä']);

    await fireEvent.click(screen.getByText('Notiz #1'));
    expect(onOpen).toHaveBeenLastCalledWith('Ordner – Ä/Notiz #1.md', { newTab: false });
    await fireEvent.click(screen.getByText('Start'), { ctrlKey: true });
    expect(onOpen).toHaveBeenLastCalledWith('Start.md', { newTab: true });
  });

  it('navigates with the keyboard: arrows, Right/Left on folders, Enter opens', async () => {
    const onOpen = vi.fn();
    render(FileTree, { root, onOpen });
    const tree = screen.getByRole('tree');
    await fireEvent.focus(tree);
    const active = () => document.getElementById(tree.getAttribute('aria-activedescendant')!)?.textContent?.trim();
    expect(active()).toBe('Ordner – Ä');
    await fireEvent.keyDown(tree, { key: 'ArrowRight' }); // expand
    await fireEvent.keyDown(tree, { key: 'ArrowRight' }); // first child
    expect(active()).toBe('Unter');
    await fireEvent.keyDown(tree, { key: 'ArrowDown' });
    expect(active()).toBe('Notiz #1');
    await fireEvent.keyDown(tree, { key: 'Enter' });
    expect(onOpen).toHaveBeenCalledWith('Ordner – Ä/Notiz #1.md', { newTab: false });
    await fireEvent.keyDown(tree, { key: 'ArrowLeft' }); // to parent
    expect(active()).toBe('Ordner – Ä');
    await fireEvent.keyDown(tree, { key: 'ArrowLeft' }); // collapse
    expect(names()).toHaveLength(3);
    await fireEvent.keyDown(tree, { key: 'End' });
    expect(active()).toBe('Start');
  });

  it('opens the context menu by keyboard; delete asks first and moves to the trash', async () => {
    const onTrashed = vi.fn();
    const confirm = vi.fn(() => true);
    vi.stubGlobal('confirm', confirm);
    render(FileTree, { root, onOpen: vi.fn(), onTrashed });
    const tree = screen.getByRole('tree');
    await fireEvent.focus(tree);
    await fireEvent.keyDown(tree, { key: 'End' });
    await fireEvent.keyDown(tree, { key: 'F10', shiftKey: true });
    const menu = await screen.findByRole('menu');
    expect(within(menu).getAllByRole('menuitem').map((b) => b.textContent?.trim())).toEqual([
      'Neue Notiz',
      expect.stringContaining('Neue Notiz aus Vorlage'),
      'Neuer Ordner',
      'Umbenennen',
      'Verschieben nach…',
      'Löschen',
    ]);
    await fireEvent.click(within(menu).getByText('Löschen'));
    expect(confirm).toHaveBeenCalledWith('Start\n\nIn den Papierkorb verschieben?');
    await vi.waitFor(() => expect(onTrashed).toHaveBeenCalledWith('Start.md'));
    expect(calls).toContainEqual({ url: '/api/entry?path=Start.md', method: 'DELETE' });
  });

  it('"Neue Notiz aus Vorlage" opens the template picker (hint without a templates folder)', async () => {
    render(FileTree, { root, onOpen: vi.fn() });
    const tree = screen.getByRole('tree');
    await fireEvent.focus(tree);
    await fireEvent.keyDown(tree, { key: 'F10', shiftKey: true });
    await fireEvent.click(within(await screen.findByRole('menu')).getByText('Neue Notiz aus Vorlage'));
    expect(await screen.findByText(de.template.noFolder)).toBeTruthy();
  });

  it('does not delete when the question is declined', async () => {
    vi.stubGlobal('confirm', () => false);
    render(FileTree, { root, onOpen: vi.fn() });
    const tree = screen.getByRole('tree');
    await fireEvent.focus(tree);
    await fireEvent.keyDown(tree, { key: 'End' });
    await fireEvent.keyDown(tree, { key: 'Delete' });
    expect(calls.filter((c) => c.method === 'DELETE')).toEqual([]);
  });

  it('drag & drop onto a folder asks to move (same dialog as "Verschieben nach…")', async () => {
    render(FileTree, { root, onOpen: vi.fn() });
    await fireEvent.dragStart(screen.getByText('Start'));
    const folder = screen.getByText('Ordner – Ä');
    await fireEvent.dragOver(folder);
    expect(items()[0]!.classList.contains('drop-target')).toBe(true);
    await fireEvent.drop(folder);
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('Verschieben nach…');
    expect((screen.getByLabelText('Zielordner') as HTMLInputElement).value).toBe('Ordner – Ä');
    expect(calls).toContainEqual({ url: '/api/rename/affected?path=Start.md', method: 'GET' });
  });

  it('renders only a window of rows for a large vault', () => {
    const big = entry('', 'folder', [
      entry('Groß', 'folder', Array.from({ length: 5000 }, (_, i) => entry(`Groß/N${i}.md`, 'note'))),
    ]);
    localStorage.setItem('vw.tree.expanded', JSON.stringify(['Groß']));
    render(FileTree, { root: big, onOpen: vi.fn() });
    const rendered = items().length;
    expect(rendered).toBeGreaterThan(10);
    expect(rendered).toBeLessThan(100);
    expect(items()[1]!.getAttribute('aria-setsize')).toBe('5000');
  });
});

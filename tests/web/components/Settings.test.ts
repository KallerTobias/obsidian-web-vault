/// <reference lib="dom" />
/// <reference types="svelte" />
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import PasskeyList from '../../../web/src/components/PasskeyList.svelte';
import SessionList from '../../../web/src/components/SessionList.svelte';
import SettingsView from '../../../web/src/components/SettingsView.svelte';
import TemplatePicker from '../../../web/src/components/TemplatePicker.svelte';
import type { TreeEntry } from '../../../web/src/lib/api';
import { de } from '../../../web/src/lib/i18n/de';
import { editorSettings } from '../../../web/src/lib/stores/settings';
import { vault } from '../../../web/src/lib/stores/vault';
import { workspace } from '../../../web/src/lib/stores/workspace';

const entry = (path: string, kind: TreeEntry['kind'], children?: TreeEntry[]): TreeEntry => ({
  path,
  name: path.split('/').pop()!,
  kind,
  mtime: 0,
  size: 0,
  readonly: false,
  ...(children ? { children } : {}),
});

const tree = entry('', 'folder', [
  entry('Vorlagen', 'folder', [entry('Vorlagen/Meeting.md', 'note'), entry('Vorlagen/Projekt.md', 'note')]),
  entry('Journal', 'folder', []),
]);

let calls: { url: string; method: string; body?: any }[];
let settings: Record<string, unknown>;
let passkeys: unknown[];
let sessions: unknown[];

beforeEach(() => {
  calls = [];
  settings = {
    attachmentFolder: '',
    newLinkFormat: 'shortest',
    newNoteFolder: '',
    templatesFolder: 'Vorlagen',
    theme: 'system',
    dailyNotes: { enabled: false, folder: '', format: 'YYYY-MM-DD', template: '' },
    graph: { mode: '2d' },
  };
  passkeys = [{ id: 'p1', name: 'Mac', transports: [], createdAt: 1, lastUsed: null }];
  sessions = [
    { id: 's1', createdAt: 1, lastSeen: 2, expiresAt: 3, userAgent: 'Macintosh', ip: '10.0.0.1', current: true },
    { id: 's2', createdAt: 1, lastSeen: 2, expiresAt: 3, userAgent: 'iPhone', ip: '10.0.0.2', current: false },
  ];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? 'GET';
      calls.push({ url, method, body: init.body ? JSON.parse(String(init.body)) : undefined });
      if (url === '/api/settings') return Response.json(settings);
      if (url === '/api/tree') return Response.json(tree);
      if (url === '/api/lookup') return Response.json([]);
      if (url === '/api/auth/passkeys' && method === 'GET') return Response.json(passkeys);
      if (url === '/api/auth/sessions' && method === 'GET') return Response.json(sessions);
      if (url.startsWith('/api/note?path=')) return Response.json({ content: '# {{title}}', version: 'v', readonly: false });
      if (url === '/api/note' && method === 'POST') return Response.json({ path: JSON.parse(String(init.body)).path, version: 'v' });
      return new Response(null, { status: 204 });
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const puts = () => calls.filter((c) => c.url === '/api/settings' && c.method === 'PUT');

describe('SettingsView', () => {
  it('saves only the changed key, debounced, and says "Gespeichert"', async () => {
    render(SettingsView);
    const input = (await screen.findByLabelText(de.settings.files.newNoteFolder)) as HTMLInputElement;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await fireEvent.input(input, { target: { value: 'Neu' } });
    await fireEvent.input(input, { target: { value: 'Neu/Notizen' } });
    expect(puts()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(500);
    expect(puts()).toHaveLength(1);
    // Only that key: the graph settings (owned by the graph tab) are never sent along.
    expect(puts()[0]!.body).toEqual({ newNoteFolder: 'Neu/Notizen' });
    expect(screen.getByRole('status').textContent).toContain(de.settings.saved);
  });

  it('merges nested daily-note changes and updates the editor store for attachment settings', async () => {
    render(SettingsView);
    const check = await screen.findByLabelText(de.settings.daily.enabled);
    const folder = screen.getByLabelText(de.settings.daily.folder);
    const att = screen.getByLabelText(de.settings.files.attachmentFolder);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await fireEvent.click(check);
    await fireEvent.input(folder, { target: { value: 'Journal' } });
    await fireEvent.input(att, { target: { value: 'Anhänge' } });
    expect(get(editorSettings).attachmentFolder).toBe('Anhänge');
    await vi.advanceTimersByTimeAsync(500);
    expect(puts()).toHaveLength(1);
    expect(puts()[0]!.body).toEqual({ dailyNotes: { enabled: true, folder: 'Journal' }, attachmentFolder: 'Anhänge' });
  });

  it('does not save an empty daily-note format', async () => {
    render(SettingsView);
    const format = await screen.findByLabelText(de.settings.daily.format);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await fireEvent.input(format, { target: { value: '  ' } });
    await vi.advanceTimersByTimeAsync(600);
    expect(puts()).toHaveLength(0);
  });

  it('offers existing folders for the folder fields', async () => {
    await vault.load();
    const { container } = render(SettingsView);
    await screen.findByLabelText(de.settings.files.newNoteFolder);
    const options = [...container.querySelectorAll('datalist option')].map((o) => o.getAttribute('value'));
    expect(options).toEqual(expect.arrayContaining(['Vorlagen', 'Journal']));
  });
});

describe('PasskeyList', () => {
  it('asks for confirmation before removing the last passkey and forces it', async () => {
    const confirmSpy = vi.fn(() => true);
    vi.stubGlobal('confirm', confirmSpy);
    render(PasskeyList);
    await fireEvent.click(await screen.findByRole('button', { name: `${de.settings.passkeys.remove}: Mac` }));
    expect(confirmSpy).toHaveBeenCalledWith(de.settings.passkeys.removeLastConfirm('Mac'));
    await waitFor(() => expect(calls.some((c) => c.method === 'DELETE')).toBe(true));
    expect(calls.find((c) => c.method === 'DELETE')!.url).toBe('/api/auth/passkeys/p1?force=1');
  });

  it('removes a non-last passkey without force and nothing when declined', async () => {
    passkeys.push({ id: 'p2', name: 'iPhone', transports: [], createdAt: 1, lastUsed: 5 });
    const confirmSpy = vi.fn(() => false);
    vi.stubGlobal('confirm', confirmSpy);
    render(PasskeyList);
    const btn = await screen.findByRole('button', { name: `${de.settings.passkeys.remove}: iPhone` });
    await fireEvent.click(btn);
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
    confirmSpy.mockReturnValue(true);
    await fireEvent.click(btn);
    await waitFor(() => expect(calls.find((c) => c.method === 'DELETE')?.url).toBe('/api/auth/passkeys/p2'));
  });

  it('renames a passkey', async () => {
    render(PasskeyList);
    await fireEvent.click(await screen.findByRole('button', { name: `${de.settings.passkeys.rename}: Mac` }));
    const field = screen.getByLabelText(de.settings.passkeys.renameLabel('Mac'));
    await fireEvent.input(field, { target: { value: 'Büro-Mac' } });
    await fireEvent.click(screen.getByRole('button', { name: de.settings.passkeys.save }));
    await waitFor(() => expect(calls.find((c) => c.method === 'PATCH')).toBeTruthy());
    expect(calls.find((c) => c.method === 'PATCH')!.body).toEqual({ name: 'Büro-Mac' });
  });
});

describe('SessionList', () => {
  it('marks this session and offers revoking only for the others', async () => {
    render(SessionList);
    const items = await screen.findAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(within(items[0]!).getByText(de.settings.sessions.current)).toBeTruthy();
    expect(within(items[0]!).queryByRole('button')).toBeNull();
    await fireEvent.click(within(items[1]!).getByRole('button'));
    await waitFor(() => expect(calls.find((c) => c.method === 'DELETE')?.url).toBe('/api/auth/sessions/s2'));
  });

  it('asks before revoking all others', async () => {
    const confirmSpy = vi.fn(() => false);
    vi.stubGlobal('confirm', confirmSpy);
    render(SessionList);
    const btn = await screen.findByRole('button', { name: de.settings.sessions.revokeOthers });
    await fireEvent.click(btn);
    expect(confirmSpy).toHaveBeenCalledWith(de.settings.sessions.revokeOthersConfirm);
    expect(calls.some((c) => c.url.endsWith('revoke-others'))).toBe(false);
    confirmSpy.mockReturnValue(true);
    await fireEvent.click(btn);
    await waitFor(() => expect(calls.some((c) => c.url === '/api/auth/sessions/revoke-others')).toBe(true));
  });
});

describe('TemplatePicker', () => {
  it('lists the templates, filters fuzzily and creates the note after asking for a title', async () => {
    await vault.load();
    const onCreated = vi.fn();
    const onClose = vi.fn();
    render(TemplatePicker, { folder: 'Journal', onCreated, onClose });
    const input = await screen.findByRole('combobox');
    expect(screen.getAllByRole('option').map((o) => o.textContent?.trim())).toEqual(['Meeting', 'Projekt']);
    await fireEvent.input(input, { target: { value: 'proj' } });
    expect(screen.getAllByRole('option')).toHaveLength(1);
    await fireEvent.keyDown(input, { key: 'Enter' });
    const title = await screen.findByLabelText(de.template.titleLabel);
    await fireEvent.input(title, { target: { value: 'Neues Projekt' } });
    await fireEvent.submit(title.closest('form')!);
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith('Journal/Neues Projekt.md'));
    expect(calls.find((c) => c.url === '/api/note' && c.method === 'POST')!.body).toEqual({
      path: 'Journal/Neues Projekt.md',
      content: '# Neues Projekt',
    });
    expect(onClose).toHaveBeenCalled();
  });

  it('rejects forbidden characters in the title without creating anything', async () => {
    await vault.load();
    const onCreated = vi.fn();
    render(TemplatePicker, { folder: '', onCreated, onClose: vi.fn() });
    await fireEvent.keyDown(await screen.findByRole('combobox'), { key: 'Enter' });
    const title = await screen.findByLabelText(de.template.titleLabel);
    await fireEvent.input(title, { target: { value: 'a/b' } });
    await fireEvent.submit(title.closest('form')!);
    expect((await screen.findByRole('alert')).textContent).toBe(de.rename.invalidName);
    expect(onCreated).not.toHaveBeenCalled();
    expect(calls.some((c) => c.url === '/api/note' && c.method === 'POST')).toBe(false);
  });

  it('points to the settings when no templates folder is set', async () => {
    settings.templatesFolder = '';
    const openSettings = vi.spyOn(workspace, 'openSettings');
    const onClose = vi.fn();
    render(TemplatePicker, { folder: '', onCreated: vi.fn(), onClose });
    expect(await screen.findByText(de.template.noFolder)).toBeTruthy();
    await fireEvent.click(screen.getByRole('button', { name: de.template.toSettings }));
    expect(openSettings).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });
});

import { get } from 'svelte/store';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../web/src/lib/api';
import { commands, filterCommands, formatHotkey, registerCommandActions } from '../../web/src/lib/commands';
import { activeNote, type ActiveNote } from '../../web/src/lib/stores/active-note';
import { theme } from '../../web/src/lib/stores/theme';
import { workspace } from '../../web/src/lib/stores/workspace';
import { get } from 'svelte/store';

afterEach(() => {
  activeNote.set(null);
  theme.set('system');
  vi.restoreAllMocks();
});

const byId = (id: string) => commands.find((c) => c.id === id)!;

describe('commands', () => {
  it('has unique ids and names', () => {
    const ids = commands.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(commands.map((c) => c.name)).size).toBe(commands.length);
  });

  it('offers the required commands', () => {
    const names = commands.map((c) => c.name);
    for (const n of [
      'Neue Notiz',
      'Neue Notiz aus Vorlage',
      'Tägliche Notiz öffnen',
      'Graph öffnen',
      'Suche',
      'Umbenennen',
      'Löschen',
      'Lesen',
      'Bearbeiten',
      'Quelltext',
      'Theme wechseln',
      'Einstellungen',
      'Abmelden',
    ]) {
      expect(names).toContain(n);
    }
  });

  it('filters with the fuzzy score, best first', () => {
    expect(filterCommands('graph').map((c) => c.id)).toEqual(['graph']);
    expect(filterCommands('xyzq')).toEqual([]);
    expect(filterCommands('')).toEqual(commands);
    const names = filterCommands('not').map((c) => c.name);
    expect(names[0]).toBe('Neue Notiz');
    expect(names).toContain('Tägliche Notiz öffnen');
  });

  it('runs workspace and registered actions', async () => {
    const openGraph = vi.spyOn(workspace, 'openGraph').mockImplementation(() => {});
    const openSettings = vi.spyOn(workspace, 'openSettings').mockImplementation(() => {});
    await byId('graph').run();
    await byId('settings').run();
    expect(openGraph).toHaveBeenCalledOnce();
    expect(openSettings).toHaveBeenCalledOnce();

    const search = vi.fn();
    const off = registerCommandActions({ openSearch: search });
    await byId('search').run();
    expect(search).toHaveBeenCalledOnce();
    off();
    await byId('search').run(); // unregistered: does nothing
    expect(search).toHaveBeenCalledOnce();
  });

  it('switches the mode of the open note', async () => {
    const setMode = vi.fn();
    activeNote.set({ mode: 'live', setMode } as unknown as ActiveNote);
    await byId('mode-reading').run();
    await byId('mode-source').run();
    await byId('mode-live').run();
    expect(setMode.mock.calls).toEqual([['reading'], ['source'], ['live']]);
    activeNote.set(null);
    await byId('mode-reading').run(); // no note: nothing happens
  });

  it('cycles the theme', async () => {
    vi.spyOn(api.settings, 'update').mockResolvedValue({} as never);
    await byId('theme').run();
    expect(get(theme)).toBe('light');
  });
});

describe('formatHotkey', () => {
  it('shows Mod as Strg or the Command key', () => {
    expect(formatHotkey('Mod-Shift-f', false)).toBe('Strg+Umschalt+F');
    expect(formatHotkey('Mod-p', true)).toBe('⌘P');
    expect(formatHotkey('Mod-Shift-f', true)).toBe('⇧⌘F');
  });
});

import { get } from 'svelte/store';
import { t } from './i18n';
import { fuzzyScore } from './fuzzy';
import { activeNote, type ActiveNote } from './stores/active-note';
import { cycleTheme } from './stores/theme';
import { workspace } from './stores/workspace';

export interface Command {
  /** Stable, unique identifier. */
  id: string;
  /** Name as shown (and searched) in the palette. */
  name: string;
  /** Shortcut in CodeMirror notation (`Mod-Shift-f`), shown next to the name. */
  hotkey?: string;
  run(): void | Promise<void>;
}

/** What only the app shell can do (it owns the file tree, the search pane and the session). */
export interface CommandActions {
  newNote(): void | Promise<void>;
  newNoteFromTemplate(): void | Promise<void>;
  /** Opens (creating it if needed) today's daily note. Implemented with the daily-note settings (Task 25). */
  openDailyNote(): void | Promise<void>;
  openSearch(): void;
  /** Renames the note in the active tab. */
  renameCurrent(): void;
  /** Moves the note in the active tab to the trash (after the usual confirmation). */
  deleteCurrent(): void | Promise<void>;
  logout(): void | Promise<void>;
}

const actions: Partial<CommandActions> = {};

/** The app shell hands in its actions; returns the function that removes them again. */
export function registerCommandActions(a: Partial<CommandActions>): () => void {
  Object.assign(actions, a);
  return () => {
    for (const key of Object.keys(a) as (keyof CommandActions)[]) {
      if (actions[key] === a[key]) delete actions[key];
    }
  };
}

const action = (name: keyof CommandActions): (() => void | Promise<void>) => {
  return () => actions[name]?.();
};

const setMode = (mode: ActiveNote['mode']) => () => get(activeNote)?.setMode(mode);

export const commands: Command[] = [
  { id: 'new-note', name: t.commands.newNote, run: action('newNote') },
  { id: 'new-note-template', name: t.commands.newNoteFromTemplate, run: action('newNoteFromTemplate') },
  { id: 'daily-note', name: t.commands.dailyNote, run: action('openDailyNote') },
  { id: 'graph', name: t.commands.graph, run: () => workspace.openGraph() },
  { id: 'search', name: t.commands.search, hotkey: 'Mod-Shift-f', run: action('openSearch') },
  { id: 'rename', name: t.commands.rename, run: action('renameCurrent') },
  { id: 'delete', name: t.commands.delete, run: action('deleteCurrent') },
  { id: 'mode-reading', name: t.commands.modeReading, run: setMode('reading') },
  { id: 'mode-live', name: t.commands.modeLive, run: setMode('live') },
  { id: 'mode-source', name: t.commands.modeSource, run: setMode('source') },
  { id: 'theme', name: t.commands.theme, run: () => void cycleTheme() },
  { id: 'settings', name: t.commands.settings, run: () => workspace.openSettings() },
  { id: 'logout', name: t.commands.logout, run: action('logout') },
];

/** Commands matching `query` (fuzzy on the name), best first; all of them in their order for an empty query. */
export function filterCommands(query: string, list: readonly Command[] = commands): Command[] {
  if (query.trim() === '') return [...list];
  return list
    .map((c) => ({ c, score: fuzzyScore(query.trim(), c.name) }))
    .filter((x): x is { c: Command; score: number } => x.score !== null)
    .sort((a, b) => b.score - a.score)
    .map((x) => x.c);
}

/** `Mod-Shift-f` as the user reads it: `Strg+Umschalt+F`, on Apple keyboards `⇧⌘F`. */
export function formatHotkey(hotkey: string, mac = /Mac|iPhone|iPad/.test(globalThis.navigator?.platform ?? '')): string {
  const parts = hotkey.split('-');
  const key = parts.pop()!;
  const mods = new Set(parts);
  const letter = key.length === 1 ? key.toUpperCase() : key;
  if (mac) return (mods.has('Alt') ? '⌥' : '') + (mods.has('Shift') ? '⇧' : '') + (mods.has('Mod') ? '⌘' : '') + letter;
  return [mods.has('Mod') && t.keys.mod, mods.has('Alt') && t.keys.alt, mods.has('Shift') && t.keys.shift, letter]
    .filter(Boolean)
    .join('+');
}

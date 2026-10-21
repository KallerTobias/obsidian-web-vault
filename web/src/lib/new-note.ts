import { basename, joinPath } from '@shared/normalize';
import { applyTemplate, dailyNotePath } from '@shared/template';
import { get } from 'svelte/store';
import { ApiError, api, type Settings } from './api';
import { de } from './i18n/de';
import { isValidNoteName } from './names';
import { vault } from './stores/vault';
import { workspace } from './stores/workspace';

/** The title is not usable as a file name (message is German, ready to show). */
export class InvalidNoteNameError extends Error {
  constructor() {
    super(de.rename.invalidName);
    this.name = 'InvalidNoteNameError';
  }
}

/** What creating notes needs from the outside; tests hand in fakes. */
export interface NewNoteDeps {
  getSettings(): Promise<{ dailyNotes: Settings['dailyNotes'] }>;
  readNote(path: string): Promise<string>;
  /** Throws `ApiError` 409 when the path exists. */
  createNote(path: string, content: string): Promise<{ path: string }>;
  /** Whether the vault already has `path` (as far as the client knows; case-insensitive). */
  exists(path: string): boolean;
  open(path: string): void;
  /** Reloads the tree and lookup after a creation. */
  refresh(): void;
  now(): Date;
}

export const defaultNewNoteDeps: NewNoteDeps = {
  getSettings: () => api.settings.get(),
  readNote: async (path) => (await api.note.get(path)).content,
  createNote: (path, content) => api.note.create(path, content),
  exists: (path) => {
    const key = path.toLowerCase();
    return get(vault.lookup).some((e) => e.path.toLowerCase() === key);
  },
  open: (path) => workspace.open(path),
  refresh: () => void vault.load().catch(() => {}),
  now: () => new Date(),
};

const MAX_ATTEMPTS = 20;

const is409 = (err: unknown) => err instanceof ApiError && err.status === 409;

/**
 * Path for a new note in `folder`: `title.md`, or `title 1.md`, `title 2.md` … while `exists` says the
 * name is taken. An empty title becomes "Unbenannt". Throws `InvalidNoteNameError` for forbidden characters.
 */
export function newNotePath(folder: string, title: string, exists: (path: string) => boolean): string {
  const t = title.trim() || de.files.untitled;
  if (!isValidNoteName(t)) throw new InvalidNoteNameError();
  for (let i = 0; ; i++) {
    const path = joinPath(folder, `${i === 0 ? t : `${t} ${i}`}.md`);
    if (!exists(path)) return path;
  }
}

/**
 * Creates a note from a template in `targetFolder` (placeholders filled in) and returns its path.
 * If the name is taken in the meantime the next number is used; nothing is ever overwritten.
 */
export async function createFromTemplate(
  templatePath: string,
  targetFolder: string,
  title: string,
  deps: NewNoteDeps = defaultNewNoteDeps,
): Promise<string> {
  newNotePath(targetFolder, title, () => false); // validate before any request
  const text = await deps.readNote(templatePath);
  const now = deps.now();
  const taken = new Set<string>();
  for (let attempt = 0; ; attempt++) {
    const path = newNotePath(targetFolder, title, (p) => deps.exists(p) || taken.has(p.toLowerCase()));
    try {
      await deps.createNote(path, applyTemplate(text, { title: basename(path).slice(0, -3), now }));
      deps.refresh();
      return path;
    } catch (err) {
      if (!is409(err) || attempt >= MAX_ATTEMPTS) throw err;
      taken.add(path.toLowerCase());
    }
  }
}

export type DailyNoteResult = { status: 'disabled' } | { status: 'opened'; path: string; created: boolean };

/** Opens today's daily note, creating it (with the template from the settings) if it is missing. */
export async function openDailyNote(deps: NewNoteDeps = defaultNewNoteDeps): Promise<DailyNoteResult> {
  const { dailyNotes } = await deps.getSettings();
  if (!dailyNotes.enabled) return { status: 'disabled' };
  const now = deps.now();
  const path = dailyNotePath(now, dailyNotes.folder, dailyNotes.format);
  let created = false;
  if (!deps.exists(path)) {
    const template = dailyNotes.template.trim();
    // A missing template must not keep the day's note from being created.
    const text = template ? await deps.readNote(template).catch(() => '') : '';
    try {
      await deps.createNote(path, applyTemplate(text, { title: basename(path).slice(0, -3), now }));
      created = true;
      deps.refresh();
    } catch (err) {
      // Exists already (the client did not know yet): just open it.
      if (!is409(err)) throw err;
    }
  }
  deps.open(path);
  return { status: 'opened', path, created };
}

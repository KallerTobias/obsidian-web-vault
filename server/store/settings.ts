import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { JsonStore } from './json-store';

export interface GraphSettings {
  mode: '2d' | '3d';
  filter: string;
  showTags: boolean;
  showAttachments: boolean;
  showOrphans: boolean;
  groups: { query: string; color: string }[];
  /** Relative multipliers; 1 = neutral default. */
  repel: number;
  linkDistance: number;
  center: number;
  nodeSize: number;
  /** Depth (hops) of the local graph. */
  localDepth: number;
}

export interface Settings {
  /** '' = vault root, './' = folder of the note, otherwise a vault-relative path. */
  attachmentFolder: string;
  newLinkFormat: 'shortest' | 'absolute' | 'relative';
  templatesFolder: string;
  dailyNotes: { enabled: boolean; folder: string; format: string; template: string };
  newNoteFolder: string;
  theme: 'system' | 'light' | 'dark';
  graph: GraphSettings;
}

export const defaultSettings = (): Settings => ({
  attachmentFolder: '',
  newLinkFormat: 'shortest',
  templatesFolder: '',
  dailyNotes: { enabled: false, folder: '', format: 'YYYY-MM-DD', template: '' },
  newNoteFolder: '',
  theme: 'system',
  graph: {
    mode: '2d',
    filter: '',
    showTags: false,
    showAttachments: false,
    showOrphans: true,
    groups: [],
    repel: 1,
    linkDistance: 1,
    center: 1,
    nodeSize: 1,
    localDepth: 1,
  },
});

const LINK_FORMATS = ['shortest', 'relative', 'absolute'] as const;

/** Reads Obsidian's settings (read-only). Missing or invalid file/values -> nothing taken over. */
async function readObsidianOverrides(vaultDir: string): Promise<Partial<Settings>> {
  let app: unknown;
  try {
    app = JSON.parse(await readFile(join(vaultDir, '.obsidian', 'app.json'), 'utf8'));
  } catch {
    return {};
  }
  if (typeof app !== 'object' || app === null) return {};
  const { attachmentFolderPath, newLinkFormat } = app as Record<string, unknown>;
  const out: Partial<Settings> = {};
  if (typeof attachmentFolderPath === 'string') {
    out.attachmentFolder = attachmentFolderPath === '/' ? '' : attachmentFolderPath;
  }
  if (typeof newLinkFormat === 'string' && (LINK_FORMATS as readonly string[]).includes(newLinkFormat)) {
    out.newLinkFormat = newLinkFormat as Settings['newLinkFormat'];
  }
  return out;
}

/**
 * Loads `<dataDir>/settings.json`. Only when that file does not exist yet are the
 * attachment folder and link format seeded from `.obsidian/app.json` (and saved).
 */
export async function loadSettings(dataDir: string, vaultDir: string): Promise<JsonStore<Settings>> {
  const store = new JsonStore<Settings>(join(dataDir, 'settings.json'), defaultSettings());
  try {
    await readFile(join(dataDir, 'settings.json'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    const overrides = await readObsidianOverrides(vaultDir);
    await store.update((s) => Object.assign(s, overrides));
    return store;
  }
  await store.load();
  return store;
}

import { findFrontmatter, parseNote } from '@shared/parse';

/** How a frontmatter value is shown and edited in the properties panel. */
export type PropertyType = 'text' | 'list' | 'number' | 'checkbox' | 'date' | 'datetime' | 'tags';

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
/** Date and time, optional seconds/fraction and zone (`Z`, `+02:00`); the zone is group 4. */
export const DATETIME_RE = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/;

/** A real calendar day (no month 13, no 31 February). */
function validDate(ymd: string): boolean {
  const m = DATE_RE.exec(ymd);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d;
}

function validDateTime(s: string): boolean {
  const m = DATETIME_RE.exec(s);
  return m !== null && validDate(m[1]!) && Number(m[2]) < 24 && Number(m[3]) < 60;
}
/** Keys Obsidian always treats as lists. */
const LIST_KEYS = new Set(['aliases', 'alias', 'cssclasses']);

/** The editor for `key: value`: by well-known key first (tags, aliases), then by the value's shape. */
export function inferPropertyType(key: string, value: unknown): PropertyType {
  const k = key.toLowerCase();
  if (k === 'tags' || k === 'tag') return 'tags';
  if (LIST_KEYS.has(k)) return 'list';
  if (Array.isArray(value)) return 'list';
  if (typeof value === 'boolean') return 'checkbox';
  if (typeof value === 'number' && Number.isFinite(value)) return 'number';
  if (value instanceof Date) return 'datetime';
  if (typeof value === 'string') {
    if (validDate(value)) return 'date';
    if (validDateTime(value)) return 'datetime';
  }
  return 'text';
}

/** A list or tags value as strings (a plain string is split at commas; tags also at spaces, without `#`). */
export function listValue(value: unknown, tags = false): string[] {
  let items: string[];
  if (Array.isArray(value)) items = value.filter((v) => v != null).map((v) => String(v));
  else if (value == null || value === '') items = [];
  else items = String(value).split(tags ? /[,\s]+/ : ',');
  return items.map((s) => (tags ? s.trim().replace(/^#/, '') : s.trim())).filter((s) => s !== '');
}

/** Adds the comma-separated items of `input` to `list` (tags without `#`), skipping empty and duplicate ones. */
export function addListItems(list: string[], input: string, tags: boolean): string[] {
  const out = list.slice();
  for (const raw of input.split(',')) {
    const item = tags ? raw.trim().replace(/^#/, '') : raw.trim();
    if (item !== '' && !out.includes(item)) out.push(item);
  }
  return out;
}

export type PropertiesState =
  | { state: 'none' }
  | { state: 'invalid' }
  | { state: 'ok'; entries: [string, unknown][] };

/** The note's frontmatter as ordered key/value pairs; `invalid` when the block exists but is not a YAML mapping. */
export function readProperties(text: string): PropertiesState {
  const fm = findFrontmatter(text, text.charCodeAt(0) === 0xfeff ? 1 : 0);
  if (!fm) return { state: 'none' };
  const note = parseNote(text.slice(0, fm.to)); // the body does not matter here
  if (!note.frontmatter) return { state: 'invalid' };
  return { state: 'ok', entries: Object.entries(note.frontmatter) };
}

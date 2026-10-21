import { de } from './de';
import { en } from './en';
import { es } from './es';
import { fr } from './fr';
import { it } from './it';

/**
 * UI language. All packs are bundled; the language is chosen once at page load (per device, in
 * localStorage) and a change reloads the page, so components read `t` as plain constants.
 */

/** The shape every language pack has; the German pack is the source of truth. */
export type Messages = typeof de;

/** Supported languages with their native names (never translated). */
export const LANGUAGES = [
  { code: 'de', name: 'Deutsch' },
  { code: 'en', name: 'English' },
  { code: 'es', name: 'Español' },
  { code: 'fr', name: 'Français' },
  { code: 'it', name: 'Italiano' },
] as const;

export type Language = (typeof LANGUAGES)[number]['code'];
/** What the user picked: a language, or `auto` (the browser's language). */
export type LanguagePreference = Language | 'auto';

const PACKS: Record<Language, Messages> = { de, en, es, fr, it };
const STORAGE_KEY = 'vw-language';
/** Language when none of the browser's languages is supported. */
const FALLBACK: Language = 'en';
/** Longest wait for pending saves before the reload (the draft mechanism keeps whatever is still unsaved). */
const FLUSH_TIMEOUT_MS = 5_000;

const isLanguage = (v: unknown): v is Language => typeof v === 'string' && Object.hasOwn(PACKS, v);

/**
 * The language to show: a stored language wins; otherwise (`auto`, nothing or an invalid value) the
 * first browser language whose primary subtag is supported (`de-AT` → `de`), else English.
 */
export function resolveLanguage(stored: string | null | undefined, browserLanguages: readonly string[]): Language {
  if (isLanguage(stored)) return stored;
  for (const tag of browserLanguages) {
    const primary = tag.split('-')[0]!.toLowerCase();
    if (isLanguage(primary)) return primary;
  }
  return FALLBACK;
}

/** The browser's preferred languages, most preferred first. */
export function browserLanguages(): readonly string[] {
  if (typeof navigator === 'undefined') return [];
  if (navigator.languages?.length) return navigator.languages;
  return navigator.language ? [navigator.language] : [];
}

/** The stored choice of this device; missing, invalid or blocked storage is `auto`. */
export function getLanguagePreference(): LanguagePreference {
  try {
    const v = globalThis.localStorage?.getItem(STORAGE_KEY);
    return isLanguage(v) ? v : 'auto';
  } catch {
    return 'auto';
  }
}

type BeforeReload = () => unknown;
const beforeReload = new Set<BeforeReload>();

/**
 * Registers work that must finish before a language change reloads the page (pending saves).
 * Returns the function that unregisters it.
 */
export function beforeLanguageReload(fn: BeforeReload): () => void {
  beforeReload.add(fn);
  return () => beforeReload.delete(fn);
}

let reloading = false;

/**
 * A language change is reloading the page right now. The page then skips its "unsaved changes"
 * prompt (the drafts are kept anyway): a cancelled reload would leave the new choice stored while
 * the page still shows the old language, and the next reload would switch silently.
 */
export function isLanguageReload(): boolean {
  return reloading;
}

/**
 * Reloads the page in the new language after the registered pending saves have finished (failures
 * are fine: unsaved text is kept as a draft when the page unloads; a save that hangs is given up
 * after a few seconds for the same reason). The choice is stored only right before the reload, so
 * a page closed while saving keeps its old language.
 */
export async function setLanguagePreference(pref: LanguagePreference, reload: () => void = () => location.reload()): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => (timer = setTimeout(resolve, FLUSH_TIMEOUT_MS)));
  const flushed = Promise.allSettled([...beforeReload].map(async (fn) => fn()));
  await Promise.race([flushed, timeout]);
  clearTimeout(timer);
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, pref);
  } catch {
    /* blocked storage: the page stays on auto */
  }
  reloading = true;
  reload();
}

/** The language of this page load. */
export const lang: Language = resolveLanguage(getLanguagePreference(), browserLanguages());
/** The UI strings of this page load. */
export const t: Messages = PACKS[lang];

if (typeof document !== 'undefined') document.documentElement.lang = lang;

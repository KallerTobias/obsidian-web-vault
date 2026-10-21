import { lang } from './i18n';

/** A timestamp (ms) as the user reads it in the UI language, e.g. `19.10.2026, 14:30` in German. */
export function formatDateTime(ms: number): string {
  return new Date(ms).toLocaleString(lang, { dateStyle: 'medium', timeStyle: 'short' });
}

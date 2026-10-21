import dayjs from 'dayjs';
import 'dayjs/locale/de.js';

/*
 * Template placeholders for new notes. Dates are formatted in the local time of the given Date (German locale),
 * so results do not depend on the machine's timezone beyond what the Date itself carries.
 */

const PLACEHOLDER_RE = /\{\{(title|date|time)(?::([^{}]*))?\}\}/g;

function fmt(now: Date, format: string): string {
  return dayjs(now).locale('de').format(format);
}

/** Replaces `{{title}}`, `{{date}}`, `{{time}}`, `{{date:FORMAT}}` and `{{time:FORMAT}}`; unknown placeholders stay. */
export function applyTemplate(text: string, ctx: { title: string; now: Date }): string {
  return text.replace(PLACEHOLDER_RE, (_m, name: string, format: string | undefined) => {
    if (name === 'title') return format === undefined ? ctx.title : _m;
    if (format !== undefined && format !== '') return fmt(ctx.now, format);
    return fmt(ctx.now, name === 'date' ? 'YYYY-MM-DD' : 'HH:mm');
  });
}

/** Vault-relative path of the daily note, e.g. `Journal/2026/10-19.md`. */
export function dailyNotePath(now: Date, folder: string, format: string): string {
  const dir = folder.replace(/^\/+|\/+$/g, '');
  const file = `${fmt(now, format)}.md`;
  return dir ? `${dir}/${file}` : file;
}

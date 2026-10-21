/** A timestamp (ms) as the user reads it: `19.10.2026, 14:30`. */
export function formatDateTime(ms: number): string {
  return new Date(ms).toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' });
}

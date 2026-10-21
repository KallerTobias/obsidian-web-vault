import { get, writable } from 'svelte/store';
import { api } from '../api';

export type ThemePreference = 'system' | 'light' | 'dark';

const KEY = 'vw.theme';
const DARK_QUERY = '(prefers-color-scheme: dark)';

function stored(): ThemePreference {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}

/** The user's choice; `system` follows `prefers-color-scheme` live. Server settings are the source of truth once loaded. */
export const theme = writable<ThemePreference>(stored());

/**
 * Sets `data-theme` on `<html>` to the effective scheme (`light`/`dark`) and keeps it in sync with
 * the preference, the OS setting and other tabs. Call once at startup, before mounting.
 */
export function initTheme(): void {
  const root = document.documentElement;
  const media = window.matchMedia(DARK_QUERY);
  let pref: ThemePreference = 'system';
  const apply = () => {
    const effective = pref === 'system' ? (media.matches ? 'dark' : 'light') : pref;
    root.dataset.theme = effective;
    root.dataset.themePreference = pref;
  };
  theme.subscribe((p) => {
    pref = p;
    apply();
    try {
      if (p === 'system') localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, p);
    } catch {
      /* storage blocked: the theme still applies for this page */
    }
  });
  media.addEventListener('change', apply);
  window.addEventListener('storage', (e) => {
    if (e.key === KEY) theme.set(stored());
  });
}

const ORDER: ThemePreference[] = ['system', 'light', 'dark'];

/** The preference a toggle switches to from `current`. */
export const nextTheme = (current: ThemePreference): ThemePreference => ORDER[(ORDER.indexOf(current) + 1) % ORDER.length]!;

/** Switches to the next preference and tells the server (settings are the shared source of truth; a failure only loses the sync). */
export function cycleTheme(): ThemePreference {
  const value = nextTheme(get(theme));
  theme.set(value);
  api.settings.update({ theme: value }).catch(() => {});
  return value;
}

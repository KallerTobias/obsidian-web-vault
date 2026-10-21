import { writable } from 'svelte/store';

/** What the app shows: still asking the server, passkey setup, login, or the vault. */
export type SessionState = 'loading' | 'setup' | 'login' | 'ready';

export const session = {
  state: writable<SessionState>('loading'),
  /** Set by the API client on any 401 outside the login/setup ceremonies; the app then offers a new login. */
  expired: writable(false),
};

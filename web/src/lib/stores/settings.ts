import { writable } from 'svelte/store';
import type { Settings } from '../api';

/** The settings the editor needs; defaults until the server's settings are loaded. */
export const editorSettings = writable<Pick<Settings, 'newLinkFormat' | 'attachmentFolder'>>({
  newLinkFormat: 'shortest',
  attachmentFolder: '',
});

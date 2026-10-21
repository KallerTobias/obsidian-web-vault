import { writable } from 'svelte/store';

/** The note shown in the active tab, as the right panel (properties, outline) sees and changes it. */
export interface ActiveNote {
  path: string;
  /** The editor's current text. */
  text: string;
  readonly: boolean;
  mode: 'live' | 'source' | 'reading';
  /**
   * Changes the text through the editor (one undo step, saved like typing): `fn` gets the editor's current
   * text (not the possibly older `text` snapshot) and returns the new one. Ignored for read-only notes.
   */
  edit(fn: (text: string) => string): void;
  /** Moves the cursor to the 0-based line and scrolls there. */
  revealLine(line: number): void;
  /** Scrolls to a heading: in the editor by its line, in the reading view by its text. */
  revealHeading(heading: { line: number; text: string }): void;
  /** Switches the note to Quelltext (e.g. to fix invalid frontmatter). */
  openSource(): void;
  /** Switches between Bearbeiten (`live`), Quelltext (`source`) and Lesen (`reading`). */
  setMode(mode: ActiveNote['mode']): void;
}

/** Set by the mounted NoteView (only the active tab's note is mounted); null for other tabs. */
export const activeNote = writable<ActiveNote | null>(null);

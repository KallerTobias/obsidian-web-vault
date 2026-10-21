import { createFileLookup, linkTextFor, type FileLookup } from '@shared/resolve';
import type { Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { ApiError } from '../api';
import { t } from '../i18n';
import { mediaKind } from '../media';

/** The server's upload limit. */
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

export interface PasteOptions {
  /** Stores the file in the vault; `pasted`: a clipboard image without a real name (the server names it `Pasted image …`). */
  upload(file: File, pasted: boolean): Promise<{ path: string }>;
  /** Text inside `[[ ]]` for the stored file's path. */
  linkText(path: string): string;
  /** A German message for the user (upload failed, file too large). */
  onError(message: string): void;
}

/** `linkTextFor` for a file the lookup does not know yet (it was uploaded a moment ago). */
export function attachmentLinkText(
  path: string,
  sourcePath: string,
  files: FileLookup,
  format: 'shortest' | 'absolute' | 'relative',
): string {
  return linkTextFor(path, sourcePath, createFileLookup([...files.byPath.values(), path]), format);
}

/** `![[x.png]]` for things Obsidian can show inline (images, PDF, audio, video), `[[x.zip]]` for the rest. */
function embedFor(path: string, linkText: string): string {
  return mediaKind(path) === 'other' ? `[[${linkText}]]` : `![[${linkText}]]`;
}

/** Clipboard screenshots arrive as `image.png` or without a name; real files keep theirs. */
function isAnonymousImage(file: File): boolean {
  return file.type.startsWith('image/') && (file.name === '' || /^image\.\w+$/i.test(file.name));
}

let counter = 0;

/** Inserts a placeholder per file at `pos`, uploads, and swaps each placeholder for its link (or removes it on failure). */
function insertFiles(view: EditorView, files: File[], pos: number, opts: PasteOptions, pasted: boolean): void {
  const accepted: File[] = [];
  for (const f of files) {
    if (f.size > MAX_UPLOAD_BYTES) opts.onError(t.editor.uploadTooLarge(f.name || t.editor.unnamedFile));
    else accepted.push(f);
  }
  if (accepted.length === 0) return;

  const marks = accepted.map(() => `![${t.editor.uploading} ${++counter}]()`);
  view.dispatch({
    changes: { from: pos, insert: marks.join('\n') },
    selection: { anchor: pos + marks.join('\n').length },
    userEvent: pasted ? 'input.paste' : 'input.drop',
    scrollIntoView: true,
  });

  /** Replaces `mark` (wherever it is by now) with `insert`; false if the user deleted it meanwhile. */
  const replace = (mark: string, insert: string): boolean => {
    if (!view.dom.isConnected) return false;
    const doc = view.state.doc.toString();
    const at = doc.indexOf(mark);
    if (at < 0) return false;
    let from = at;
    let to = at + mark.length;
    if (insert === '') {
      // Also take one line break with it (several files: one link per line).
      if (doc[to] === '\n') to++;
      else if (from > 0 && doc[from - 1] === '\n' && marks.length > 1) from--;
    }
    view.dispatch({ changes: { from, to, insert } });
    return true;
  };

  accepted.forEach((file, i) => {
    const mark = marks[i]!;
    opts.upload(file, pasted && isAnonymousImage(file)).then(
      ({ path }) => {
        replace(mark, embedFor(path, opts.linkText(path)));
      },
      (err: unknown) => {
        replace(mark, '');
        opts.onError(err instanceof ApiError && err.status === 413 ? t.editor.uploadTooLarge(file.name) : t.editor.uploadFailed(file.name || t.editor.unnamedFile));
      },
    );
  });
}

/** Files from the clipboard or a drop: uploaded, then linked at the cursor (drop: at the drop position). */
export function pasteImages(opts: PasteOptions): Extension {
  return EditorView.domEventHandlers({
    paste(event, view) {
      const files = [...(event.clipboardData?.files ?? [])];
      if (files.length === 0 || view.state.readOnly) return false;
      event.preventDefault();
      insertFiles(view, files, view.state.selection.main.head, opts, true);
      return true;
    },
    drop(event, view) {
      const files = [...(event.dataTransfer?.files ?? [])];
      if (files.length === 0 || view.state.readOnly) return false;
      event.preventDefault();
      const pos = view.posAtCoords({ x: event.clientX, y: event.clientY }) ?? view.state.selection.main.head;
      insertFiles(view, files, pos, opts, false);
      return true;
    },
  });
}

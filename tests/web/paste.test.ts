/// <reference lib="dom" />
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { createFileLookup } from '@shared/resolve';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../web/src/lib/api';
import { attachmentLinkText, MAX_UPLOAD_BYTES, pasteImages, type PasteOptions } from '../../web/src/lib/editor/paste';

let view: EditorView | undefined;
afterEach(() => view?.destroy());

function setup(doc: string, upload: PasteOptions['upload'], readOnly = false) {
  const onError = vi.fn();
  view = new EditorView({
    parent: document.body,
    state: EditorState.create({
      doc,
      selection: { anchor: doc.indexOf('|') < 0 ? doc.length : doc.indexOf('|') },
      extensions: [pasteImages({ upload, linkText: (p) => p.split('/').pop()!.replace(/\.md$/, ''), onError }), EditorState.readOnly.of(readOnly)],
    }),
  });
  if (doc.includes('|')) view.dispatch({ changes: { from: doc.indexOf('|'), to: doc.indexOf('|') + 1 } });
  return { view, onError };
}

const file = (name: string, type: string, size = 10) => {
  const f = new File(['x'], name, { type });
  Object.defineProperty(f, 'size', { value: size });
  return f;
};

function fire(v: EditorView, type: 'paste' | 'drop', files: File[], text = ''): Event {
  const e = new Event(type, { bubbles: true, cancelable: true });
  const data = { files, getData: (t: string) => (t === 'text/plain' ? text : ''), types: text ? ['text/plain', 'Files'] : ['Files'] };
  Object.defineProperty(e, type === 'paste' ? 'clipboardData' : 'dataTransfer', { value: data });
  v.contentDOM.dispatchEvent(e);
  return e;
}

const deferred = <T>() => {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)));
  return { promise, resolve, reject };
};

describe('pasteImages', () => {
  it('uploads a pasted image, shows a placeholder meanwhile, then inserts the embed', async () => {
    const d = deferred<{ path: string }>();
    const upload = vi.fn(() => d.promise);
    const { view: v } = setup('a |b', upload);
    const e = fire(v, 'paste', [file('image.png', 'image/png')]);
    expect(e.defaultPrevented).toBe(true);
    expect(upload).toHaveBeenCalledWith(expect.any(File), true);
    expect(v.state.sliceDoc()).toMatch(/^a !\[Hochladen…[^\]]*\]\(\)b$/);
    d.resolve({ path: 'Anhänge/Pasted image 20261020143005.png' });
    await vi.waitFor(() => expect(v.state.sliceDoc()).toBe('a ![[Pasted image 20261020143005.png]]b'));
  });

  it('a named image (drop) keeps its name: not "pasted"', async () => {
    const upload = vi.fn(async () => ({ path: 'foto.jpg' }));
    const { view: v } = setup('', upload);
    fire(v, 'drop', [file('foto.jpg', 'image/jpeg')]);
    expect(upload).toHaveBeenCalledWith(expect.any(File), false);
    await vi.waitFor(() => expect(v.state.sliceDoc()).toBe('![[foto.jpg]]'));
  });

  it('several files: one link per line; other files are links, pdf/audio/video embeds', async () => {
    const upload = vi.fn(async (f: File) => ({ path: f.name }));
    const { view: v } = setup('', upload);
    fire(v, 'drop', [file('a.png', 'image/png'), file('b.pdf', 'application/pdf'), file('c.zip', 'application/zip'), file('d.mp3', 'audio/mpeg')]);
    await vi.waitFor(() => expect(v.state.sliceDoc()).toBe('![[a.png]]\n![[b.pdf]]\n[[c.zip]]\n![[d.mp3]]'));
  });

  it('removes the placeholder and reports a German error when the upload fails', async () => {
    const upload = vi.fn(async () => {
      throw new ApiError(500, { error: 'kaputt' });
    });
    const { view: v, onError } = setup('x ', upload);
    fire(v, 'paste', [file('image.png', 'image/png')]);
    await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    expect(v.state.sliceDoc()).toBe('x ');
    expect(onError.mock.calls[0]![0]).toMatch(/Hochladen/);
  });

  it('refuses files above 50 MB without uploading', () => {
    const upload = vi.fn();
    const { view: v, onError } = setup('', upload);
    fire(v, 'drop', [file('riesig.png', 'image/png', MAX_UPLOAD_BYTES + 1)]);
    expect(upload).not.toHaveBeenCalled();
    expect(onError.mock.calls[0]![0]).toMatch(/riesig\.png.*50 MB/);
    expect(v.state.sliceDoc()).toBe('');
  });

  it('leaves text pastes alone, and read-only editors', () => {
    const upload = vi.fn();
    const { view: v } = setup('', upload);
    fire(v, 'paste', [], 'nur Text');
    expect(upload).not.toHaveBeenCalled();
    expect(v.state.sliceDoc()).toBe('nur Text');
    v.destroy();
    const ro = setup('', upload, true);
    fire(ro.view, 'paste', [file('image.png', 'image/png')]);
    expect(upload).not.toHaveBeenCalled();
  });

  it('keeps editing safe when the placeholder was deleted meanwhile', async () => {
    const d = deferred<{ path: string }>();
    const { view: v } = setup('', () => d.promise);
    fire(v, 'paste', [file('image.png', 'image/png')]);
    v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: 'neu' } });
    d.resolve({ path: 'x.png' });
    await new Promise((r) => setTimeout(r, 0));
    expect(v.state.sliceDoc()).toBe('neu');
  });
});

describe('attachmentLinkText', () => {
  it('formats a new attachment that the lookup does not know yet', () => {
    const files = createFileLookup(['Notiz.md', 'Anhänge/alt.png']);
    expect(attachmentLinkText('Anhänge/neu.png', 'Notiz.md', files, 'shortest')).toBe('neu.png');
    expect(attachmentLinkText('Anhänge/alt-1.png', 'Notiz.md', files, 'absolute')).toBe('Anhänge/alt-1.png');
    expect(attachmentLinkText('Anhänge/neu.png', 'Ordner/Notiz.md', files, 'relative')).toBe('../Anhänge/neu.png');
  });
});

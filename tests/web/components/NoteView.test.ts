/// <reference lib="dom" />
/// <reference types="svelte" />
import { EditorView } from '@codemirror/view';
import { createFileLookup } from '@shared/resolve';
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ConflictDialog from '../../../web/src/components/ConflictDialog.svelte';
import NoteView from '../../../web/src/components/NoteView.svelte';
import { session } from '../../../web/src/lib/stores/session';
import { activeNote } from '../../../web/src/lib/stores/active-note';
import { get } from 'svelte/store';

type Call = { url: string; method: string; body: any };
let calls: Call[];
let note: { content: string; version: string; readonly: boolean };
/** Answers for PUT /api/note, in order; afterwards: success with a new version. */
let putAnswers: Response[];
let version = 0;

beforeEach(() => {
  calls = [];
  putAnswers = [];
  note = { content: '# Titel\n- [ ] eins\n', version: 'v0', readonly: false };
  localStorage.clear();
  session.expired.set(false);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? 'GET';
      calls.push({ url, method, body: init.body ? JSON.parse(String(init.body)) : undefined });
      if (url.startsWith('/api/note') && method === 'GET') return Response.json(note);
      if (url.startsWith('/api/note') && method === 'PUT') return putAnswers.shift() ?? Response.json({ version: `v${++version}` });
      if (url === '/api/note' && method === 'POST') return Response.json({ path: 'x', version: 'vCopy' });
      return new Response(null, { status: 404 });
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const lookup = createFileLookup(['Ordner/Notiz.md']);
const puts = () => calls.filter((c) => c.method === 'PUT');

async function open(props: Record<string, unknown> = {}) {
  const r = render(NoteView, { path: 'Ordner/Notiz.md', lookup, ...props });
  const content = await vi.waitFor(() => {
    const el = r.container.querySelector<HTMLElement>('.cm-content');
    if (!el) throw new Error('no editor yet');
    return el;
  });
  return { ...r, view: EditorView.findFromDOM(content)! };
}

function type(view: EditorView, insert: string): void {
  view.dispatch({ changes: { from: view.state.doc.length, insert }, userEvent: 'input' });
}

describe('NoteView', () => {
  it('415 (not UTF-8): explains it, offers a download, no editor, nothing saved', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ error: 'nicht UTF-8' }, { status: 415 })),
    );
    const r = render(NoteView, { path: 'Ordner/Notiz.md', lookup });
    const alert = await screen.findByText(/nicht UTF-8-kodiert/);
    expect(alert).toBeTruthy();
    const link = screen.getByRole('link', { name: 'Datei herunterladen' });
    expect(link.getAttribute('href')).toBe('/api/file?path=Ordner%2FNotiz.md');
    expect(r.container.querySelector('.cm-content')).toBeNull();
  });

  it('opens in Bearbeiten, saves typed text automatically and shows the state', async () => {
    const { view } = await open();
    expect(screen.getByRole('button', { name: 'Bearbeiten' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByText('Gespeichert')).toBeTruthy();
    type(view, 'neu');
    expect(await screen.findByText('Ungespeichert')).toBeTruthy();
    await vi.waitFor(() => expect(puts()).toHaveLength(1), { timeout: 3000 });
    expect(puts()[0]!.url).toBe('/api/note?path=Ordner%2FNotiz.md');
    expect(puts()[0]!.body).toEqual({ content: '# Titel\n- [ ] eins\nneu', baseVersion: 'v0' });
    expect(await screen.findByText('Gespeichert')).toBeTruthy();
  });

  it('Mod-e switches to Lesen and back; ticking a task saves the line', async () => {
    const { container } = await open();
    await fireEvent.keyDown(window, { key: 'e', ctrlKey: true });
    expect(screen.getByRole('button', { name: 'Lesen' }).getAttribute('aria-pressed')).toBe('true');
    const box = container.querySelector<HTMLInputElement>('.reading-view input[type="checkbox"]')!;
    await fireEvent.click(box);
    await vi.waitFor(() => expect(puts()).toHaveLength(1), { timeout: 3000 });
    expect(puts()[0]!.body.content).toBe('# Titel\n- [x] eins\n');
    await fireEvent.keyDown(window, { key: 'e', metaKey: true });
    expect(screen.getByRole('button', { name: 'Bearbeiten' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('Quelltext shows the frontmatter in the source editor', async () => {
    note.content = '---\ntags: [a]\n---\nText';
    const { container, view } = await open();
    await fireEvent.click(screen.getByRole('button', { name: 'Quelltext' }));
    expect(container.querySelector('.cm-editor')!.classList.contains('is-source')).toBe(true);
    expect(view.state.doc.toString()).toContain('tags: [a]');
  });

  it('readonly notes: notice, editor refuses input, nothing saved', async () => {
    note.readonly = true;
    const { view } = await open();
    expect(screen.getByText('Diese Notiz ist schreibgeschützt.')).toBeTruthy();
    expect(view.state.readOnly).toBe(true);
  });

  it('restores a draft from the last visit', async () => {
    localStorage.setItem('vw-draft:Ordner/Notiz.md', JSON.stringify({ content: 'Entwurf', baseVersion: 'v0', savedAt: 1 }));
    const { view } = await open();
    expect(view.state.doc.toString()).toBe('Entwurf');
    expect(screen.getByText(/wurden wiederhergestellt/)).toBeTruthy();
    await vi.waitFor(() => expect(puts()[0]?.body).toEqual({ content: 'Entwurf', baseVersion: 'v0' }), { timeout: 3000 });
  });

  it('409: the conflict dialog; "Beide behalten" writes a copy and loads the disk version', async () => {
    putAnswers.push(Response.json({ error: 'Konflikt', diskContent: 'Platte\n', diskVersion: 'vX' }, { status: 409 }));
    const { view } = await open();
    type(view, 'mein');
    expect(await screen.findByRole('heading', { name: 'Konflikt beim Speichern' }, { timeout: 3000 })).toBeTruthy();
    await fireEvent.click(screen.getByRole('button', { name: 'Beide behalten' }));
    await vi.waitFor(() => expect(view.state.doc.toString()).toBe('Platte\n'));
    const post = calls.find((c) => c.method === 'POST')!;
    expect(post.body.path).toMatch(/^Ordner\/Notiz \(Konflikt \d{4}-\d\d-\d\d \d{4}\)\.md$/);
    expect(post.body.content).toBe('# Titel\n- [ ] eins\nmein');
    expect(screen.queryByRole('heading', { name: 'Konflikt beim Speichern' })).toBeNull();
  });

  it('401: keeps a draft, saves after the new login', async () => {
    putAnswers.push(Response.json({ error: 'Nicht angemeldet' }, { status: 401 }));
    const { view } = await open();
    type(view, 'x');
    expect(await screen.findByText(/Entwurf auf diesem Gerät gesichert/, {}, { timeout: 3000 })).toBeTruthy();
    expect(JSON.parse(localStorage.getItem('vw-draft:Ordner/Notiz.md')!).content).toBe('# Titel\n- [ ] eins\nx');
    session.expired.set(false); // the login dialog succeeded
    await vi.waitFor(() => expect(puts()).toHaveLength(2));
    expect(await screen.findByText('Gespeichert')).toBeTruthy();
    expect(localStorage.getItem('vw-draft:Ordner/Notiz.md')).toBeNull();
  });

  it('a refused save shows the server message and offers to try again', async () => {
    putAnswers.push(Response.json({ error: 'Datei zu groß' }, { status: 413 }));
    const { view } = await open();
    type(view, 'x');
    expect(await screen.findByText(/vom Server abgelehnt.*: Datei zu groß/, {}, { timeout: 3000 })).toBeTruthy();
    await fireEvent.click(screen.getByRole('button', { name: 'Jetzt speichern' }));
    await vi.waitFor(() => expect(puts()).toHaveLength(2));
    expect(await screen.findByText('Gespeichert')).toBeTruthy();
  });

  it('Mod-e does nothing while a modal dialog is open', async () => {
    await open();
    const other = document.createElement('dialog');
    other.setAttribute('open', '');
    document.body.append(other);
    try {
      await fireEvent.keyDown(window, { key: 'e', ctrlKey: true });
      expect(screen.getByRole('button', { name: 'Bearbeiten' }).getAttribute('aria-pressed')).toBe('true');
    } finally {
      other.remove();
    }
  });

  it('deleted on disk with unsaved text: keeps it and offers to save it as a new note', async () => {
    const { view, rerender } = await open();
    type(view, 'x');
    await rerender({ deleted: true });
    expect(await screen.findByText(/außerhalb gelöscht/)).toBeTruthy();
    expect(view.state.doc.toString()).toContain('x');
    await fireEvent.click(screen.getByRole('button', { name: 'Als neue Notiz speichern' }));
    await vi.waitFor(() => expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ path: 'Ordner/Notiz.md', content: '# Titel\n- [ ] eins\nx' }));
    expect(puts()).toHaveLength(0);
  });
});

describe('NoteView as the active note (right panel)', () => {
  it('publishes path and text; edit goes through the editor and is saved', async () => {
    note = { content: '---\na: 1\n---\nText\n', version: 'v0', readonly: false };
    const { view } = await open();
    await vi.waitFor(() => expect(get(activeNote)?.path).toBe('Ordner/Notiz.md'));
    expect(get(activeNote)!.text).toBe(note.content);
    get(activeNote)!.edit((t) => t.replace('a: 1', 'a: 2'));
    get(activeNote)!.edit((t) => t + 'mehr\n'); // sees the first edit although the snapshot is older
    expect(view.state.doc.toString()).toBe('---\na: 2\n---\nText\nmehr\n');
    await vi.waitFor(() => expect(get(activeNote)!.text).toBe('---\na: 2\n---\nText\nmehr\n'));
    await vi.waitFor(() => expect(puts()).toHaveLength(1), { timeout: 3000 });
    expect(puts()[0]!.body.content).toBe('---\na: 2\n---\nText\nmehr\n');
    cleanup();
    expect(get(activeNote)).toBeNull();
  });

  it('readonly: edit changes nothing', async () => {
    note = { ...note, readonly: true };
    const { view } = await open();
    await vi.waitFor(() => expect(get(activeNote)?.readonly).toBe(true));
    get(activeNote)!.edit(() => 'anders');
    expect(view.state.doc.toString()).toBe('# Titel\n- [ ] eins\n');
  });

  it('reveal moves the cursor to the line; openSource switches to Quelltext', async () => {
    note = { content: 'a\nb\nc\nd\n', version: 'v0', readonly: false };
    const { view } = await open({ reveal: { line: 2 } });
    await vi.waitFor(() => expect(view.state.selection.main.head).toBe(4));
    get(activeNote)!.revealLine(1);
    expect(view.state.selection.main.head).toBe(2);
    get(activeNote)!.openSource();
    await vi.waitFor(() => expect(screen.getByRole('button', { name: 'Quelltext' }).getAttribute('aria-pressed')).toBe('true'));
  });
});

describe('ConflictDialog', () => {
  it('shows the line diff and reports the choice', async () => {
    const onResolve = vi.fn(async () => {});
    const { container } = render(ConflictDialog, {
      path: 'Notiz.md',
      conflict: { mine: 'a\nmein', diskContent: 'a\nPlatte', diskVersion: 'v1' },
      onResolve,
    });
    expect([...container.querySelectorAll('.line.mine .text')].map((e) => e.textContent)).toEqual(['mein']);
    expect([...container.querySelectorAll('.line.disk .text')].map((e) => e.textContent)).toEqual(['Platte']);
    await fireEvent.click(screen.getByRole('button', { name: 'Meine Fassung behalten' }));
    expect(onResolve).toHaveBeenCalledWith('mine');
    await fireEvent.click(screen.getByRole('button', { name: 'Fassung von der Platte' }));
    expect(onResolve).toHaveBeenLastCalledWith('disk');
  });

  it('a failed choice shows an error', async () => {
    render(ConflictDialog, {
      path: 'Notiz.md',
      conflict: { mine: 'a', diskContent: 'b', diskVersion: 'v1' },
      onResolve: async () => {
        throw new Error('offline');
      },
    });
    await fireEvent.click(screen.getByRole('button', { name: 'Beide behalten' }));
    expect(await screen.findByRole('alert')).toBeTruthy();
  });
});

/// <reference lib="dom" />
/// <reference types="svelte" />
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import BacklinksPanel from '../../../web/src/components/BacklinksPanel.svelte';
import OutlinePanel from '../../../web/src/components/OutlinePanel.svelte';
import PropertiesPanel from '../../../web/src/components/PropertiesPanel.svelte';
import RightPanel from '../../../web/src/components/RightPanel.svelte';
import type { ActiveNote } from '../../../web/src/lib/stores/active-note';
import { activeNote } from '../../../web/src/lib/stores/active-note';
import { vault } from '../../../web/src/lib/stores/vault';
import { workspace } from '../../../web/src/lib/stores/workspace';

// The local graph's canvas needs a real browser: a chainable stand-in (GraphCanvas.test covers the wiring).
vi.mock('force-graph', () => ({
  default: vi.fn(function () {
    let data = { nodes: [], links: [] };
    const self: object = new Proxy(
      {},
      {
        get: (_, prop) =>
          prop === 'graphData'
            ? (...args: unknown[]) => (args.length ? ((data = args[0] as typeof data), self) : data)
            : prop === 'd3Force'
              ? () => undefined
              : () => self,
      },
    );
    return self;
  }),
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  activeNote.set(null);
});

/** A note whose edits are applied to `text` (as NoteView does through the editor). */
function fakeNote(text: string, extra: Partial<ActiveNote> = {}) {
  const note: ActiveNote & { edits: number } = {
    path: 'Notiz.md',
    text,
    readonly: false,
    mode: 'live',
    edits: 0,
    edit(fn) {
      note.text = fn(note.text);
      note.edits++;
    },
    revealLine: vi.fn(),
    revealHeading: vi.fn(),
    openSource: vi.fn(),
    setMode: vi.fn(),
    ...extra,
  };
  return note;
}

const input = (label: string) => screen.getByLabelText(label) as HTMLInputElement;

describe('PropertiesPanel', () => {
  it('lists the properties with an editor per type', () => {
    const note = fakeNote('---\ntitel: Hallo\nseiten: 3\nfertig: true\nlast_verified: 2026-10-16\ntags: [a, b]\n---\nText');
    render(PropertiesPanel, { note });
    expect(input('Wert von titel').value).toBe('Hallo');
    expect(input('Wert von seiten').type).toBe('number');
    expect(input('Wert von fertig').checked).toBe(true);
    expect(input('Wert von last_verified').type).toBe('date');
    expect(input('Wert von last_verified').value).toBe('2026-10-16');
    expect(screen.getByRole('button', { name: 'a entfernen' })).toBeTruthy();
  });

  it('commits a text value on blur (not per keystroke), keeping the rest byte-identical', async () => {
    const note = fakeNote('---\r\n# Kommentar\r\ntitel: Hallo\r\nn: 1\r\n---\r\nText');
    render(PropertiesPanel, { note });
    const el = input('Wert von titel');
    await fireEvent.input(el, { target: { value: 'Neu' } });
    expect(note.edits).toBe(0);
    await fireEvent.blur(el);
    expect(note.text).toBe('---\r\n# Kommentar\r\ntitel: Neu\r\nn: 1\r\n---\r\nText');
  });

  it('Enter commits; checkbox commits on change, dates on blur', async () => {
    const note = fakeNote('---\nn: 1\nok: false\nd: 2026-01-01\n---\n');
    render(PropertiesPanel, { note });
    const n = input('Wert von n');
    n.focus();
    n.value = '42';
    await fireEvent.keyDown(n, { key: 'Enter' });
    expect(note.text).toContain('n: 42\n');
    await fireEvent.click(input('Wert von ok'));
    expect(note.text).toContain('ok: true\n');
    const d = input('Wert von d');
    d.value = '2026-10-20';
    await fireEvent.change(d);
    expect(note.text).toContain('d: 2026-01-01\n'); // a date picker changes while browsing: not yet
    await fireEvent.blur(d);
    expect(note.text).toContain('d: 2026-10-20\n');
  });

  it('a number the browser cannot read resets the field instead of writing null', async () => {
    const note = fakeNote('---\nn: 5\n---\n');
    render(PropertiesPanel, { note });
    const n = input('Wert von n');
    n.value = '';
    Object.defineProperty(n, 'validity', { value: { badInput: true } });
    await fireEvent.blur(n);
    expect(note.edits).toBe(0);
    expect(n.value).toBe('5');
  });

  it('date and time with a zone: the zone is kept when the time is changed', async () => {
    const note = fakeNote('---\nt: 2026-10-16T09:30:00+02:00\n---\n');
    render(PropertiesPanel, { note });
    const t = input('Wert von t');
    expect(t.type).toBe('datetime-local');
    expect(t.value).toBe('2026-10-16T09:30'); // the picker drops zero seconds
    t.focus();
    await fireEvent.blur(t);
    expect(note.edits).toBe(0); // just looking changes nothing
    t.focus();
    t.value = '2026-10-16T10:00';
    await fireEvent.keyDown(t, { key: 'Enter' });
    expect(note.text).toBe('---\nt: 2026-10-16T10:00+02:00\n---\n');
  });

  it('tags: comma or Enter adds chips, Backspace on the empty input removes the last, × removes one', async () => {
    const note = fakeNote('---\ntags:\n  - a\n---\n');
    render(PropertiesPanel, { note });
    const el = input('Wert von tags');
    el.value = '#b';
    await fireEvent.keyDown(el, { key: ',' });
    expect(note.text).toBe('---\ntags:\n  - a\n  - b\n---\n');
    el.value = '';
    await fireEvent.keyDown(el, { key: 'Backspace' });
    expect(note.text).toBe('---\ntags:\n  - a\n---\n');
    await fireEvent.click(screen.getByRole('button', { name: 'a entfernen' }));
    expect(note.text).toBe('---\ntags: []\n---\n');
  });

  it('renames a key, refusing an existing one; removes and adds properties', async () => {
    const note = fakeNote('---\na: 1\nb: 2\n---\n');
    render(PropertiesPanel, { note });
    const keys = screen.getAllByLabelText('Name der Eigenschaft') as HTMLInputElement[];
    keys[0]!.value = 'b';
    await fireEvent.blur(keys[0]!);
    expect(await screen.findByText('Die Eigenschaft „b“ gibt es schon.')).toBeTruthy();
    expect(note.edits).toBe(0);
    keys[0]!.value = 'c';
    await fireEvent.blur(keys[0]!);
    expect(note.text).toBe('---\nc: 1\nb: 2\n---\n');
    await fireEvent.click(screen.getByRole('button', { name: 'Eigenschaft b entfernen' }));
    expect(note.text).toBe('---\nc: 1\n---\n');
    await fireEvent.click(screen.getByRole('button', { name: 'Eigenschaft hinzufügen' }));
    const fresh = screen.getByPlaceholderText('Name') as HTMLInputElement;
    fresh.value = 'neu';
    await fireEvent.keyDown(fresh, { key: 'Enter' });
    expect(note.text).toBe('---\nc: 1\nneu: ""\n---\n');
  });

  it('invalid YAML: a notice and „Im Quelltext öffnen“', async () => {
    const note = fakeNote('---\na: [\n---\n');
    render(PropertiesPanel, { note });
    expect(screen.getByText(/kein gültiges YAML/)).toBeTruthy();
    await fireEvent.click(screen.getByRole('button', { name: 'Im Quelltext öffnen' }));
    expect(note.openSource).toHaveBeenCalled();
  });

  it('read-only notes: values shown, nothing editable', () => {
    const note = fakeNote('---\na: 1\ntags: [x]\n---\n', { readonly: true });
    render(PropertiesPanel, { note });
    expect(input('Wert von a').disabled).toBe(true);
    expect(screen.queryByRole('button', { name: 'Eigenschaft hinzufügen' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'x entfernen' })).toBeNull();
  });
});

describe('OutlinePanel', () => {
  it('lists the headings indented by level; a click reveals the heading', async () => {
    const note = fakeNote('---\na: 1\n---\n## Zwei\ntext\n### Drei\n');
    render(OutlinePanel, { note });
    const items = await screen.findAllByRole('button');
    expect(items.map((b) => b.textContent?.trim())).toEqual(['Zwei', 'Drei']);
    expect(items[1]!.style.getPropertyValue('--depth')).toBe('1');
    await fireEvent.click(items[1]!);
    expect(note.revealHeading).toHaveBeenCalledWith(expect.objectContaining({ line: 5, text: 'Drei' }));
  });
});

type Call = { url: string; method: string; body: any };

describe('BacklinksPanel', () => {
  let calls: Call[];
  let source: string;
  let putStatus: number;
  let lookupEntries: { path: string; name: string; aliases: string[] }[];
  let backlinksAnswer: (() => Promise<Response>) | null;
  beforeEach(() => {
    calls = [];
    putStatus = 200;
    lookupEntries = [];
    backlinksAnswer = null;
    source = 'Vorher\nWir reden über ziel <b>heute</b>.\n';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit = {}) => {
        const method = init.method ?? 'GET';
        calls.push({ url, method, body: init.body ? JSON.parse(String(init.body)) : undefined });
        if (url === '/api/lookup') return Response.json(lookupEntries);
        if (url === '/api/tree') return Response.json({ path: '', name: '', kind: 'folder', children: [] });
        if (url.startsWith('/api/backlinks') && backlinksAnswer) return backlinksAnswer();
        if (url.startsWith('/api/backlinks'))
          return Response.json({
            linked: [{ source: 'A.md', contexts: [{ line: 3, text: 'Siehe [[Ziel]] und <i>x</i>' }] }],
            unlinked: [{ source: 'B.md', contexts: [{ line: 1, text: 'Wir reden über ziel <b>heute</b>.' }] }],
          });
        if (url.startsWith('/api/note') && method === 'GET') return Response.json({ content: source, version: 'v1', readonly: false });
        if (url.startsWith('/api/note') && method === 'PUT')
          return putStatus === 200
            ? Response.json({ version: 'v2' })
            : Response.json({ error: 'conflict', diskContent: 'x', diskVersion: 'v9' }, { status: 409 });
        return new Response(null, { status: 404 });
      }),
    );
  });

  it('shows linked and unlinked mentions with counts and the match highlighted as text', async () => {
    const { container } = render(BacklinksPanel, { path: 'Ziel.md', aliases: [], onOpen: vi.fn() });
    expect(await screen.findByText('Verlinkt')).toBeTruthy();
    await vi.waitFor(() => expect(container.querySelectorAll('mark')).toHaveLength(2));
    expect([...container.querySelectorAll('mark')].map((m) => m.textContent)).toEqual(['[[Ziel]]', 'ziel']);
    expect(container.querySelector('b, i')).toBeNull();
    expect(container.textContent).toContain('<b>heute</b>');
    expect(container.querySelectorAll('.count')[0]!.textContent).toBe('1');
  });

  it('a click opens the source at the line (Ctrl: new tab)', async () => {
    const onOpen = vi.fn();
    const { container } = render(BacklinksPanel, { path: 'Ziel.md', aliases: [], onOpen });
    await vi.waitFor(() => expect(container.querySelectorAll('mark')).toHaveLength(2));
    await fireEvent.click(container.querySelector('mark')!.closest('button')!);
    await fireEvent.click(container.querySelectorAll('mark')[1]!.closest('button')!, { ctrlKey: true });
    expect(onOpen.mock.calls).toEqual([
      ['A.md', 3, false],
      ['B.md', 1, true],
    ]);
  });

  it('„Verlinken“ replaces the mention with a link (alias keeps the text) and reloads', async () => {
    render(BacklinksPanel, { path: 'Ziel.md', aliases: [], onOpen: vi.fn() });
    await fireEvent.click(await screen.findByRole('button', { name: 'Verlinken' }));
    await vi.waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
    const put = calls.find((c) => c.method === 'PUT')!;
    expect(put.url).toBe('/api/note?path=B.md');
    expect(put.body).toEqual({ content: 'Vorher\nWir reden über [[Ziel|ziel]] <b>heute</b>.\n', baseVersion: 'v1' });
    await vi.waitFor(() => expect(calls.filter((c) => c.url.startsWith('/api/backlinks'))).toHaveLength(2));
  });

  it('„Verlinken“ writes the shortest link when the name is unique (the note itself is in the lookup)', async () => {
    lookupEntries = [{ path: 'Ordner/Ziel.md', name: 'Ziel', aliases: [] }, { path: 'B.md', name: 'B', aliases: [] }];
    await vault.load();
    render(BacklinksPanel, { path: 'Ordner/Ziel.md', aliases: [], onOpen: vi.fn() });
    await fireEvent.click(await screen.findByRole('button', { name: 'Verlinken' }));
    await vi.waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
    expect(calls.find((c) => c.method === 'PUT')!.body.content).toBe('Vorher\nWir reden über [[Ziel|ziel]] <b>heute</b>.\n');
    lookupEntries = [];
    await vault.load();
  });

  it('„Verlinken“ when the line changed meanwhile: nothing written, a German notice', async () => {
    source = 'Vorher\nWir reden über ziel, inzwischen anders.\n';
    render(BacklinksPanel, { path: 'Ziel.md', aliases: [], onOpen: vi.fn() });
    await fireEvent.click(await screen.findByRole('button', { name: 'Verlinken' }));
    expect(await screen.findByText('Die Erwähnung ist nicht mehr da.')).toBeTruthy();
    expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(0);
  });

  it('another note: the old backlinks disappear at once', async () => {
    const { container, rerender } = render(BacklinksPanel, { path: 'Ziel.md', aliases: [], onOpen: vi.fn() });
    await vi.waitFor(() => expect(container.querySelectorAll('mark')).toHaveLength(2));
    backlinksAnswer = () => new Promise(() => {});
    await rerender({ path: 'Anders.md', aliases: [], onOpen: vi.fn() });
    expect(container.textContent).not.toContain('Wir reden');
    expect(container.textContent).not.toContain('Siehe');
  });

  it('„Verlinken“ after a change on disk: German error, nothing overwritten', async () => {
    putStatus = 409;
    render(BacklinksPanel, { path: 'Ziel.md', aliases: [], onOpen: vi.fn() });
    await fireEvent.click(await screen.findByRole('button', { name: 'Verlinken' }));
    expect(await screen.findByText(/zwischenzeitlich geändert/)).toBeTruthy();
    expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(1);
  });
});

describe('RightPanel', () => {
  it('shows an empty state without an active note', () => {
    render(RightPanel);
    expect(screen.getByText(/Keine Notiz geöffnet/)).toBeTruthy();
  });

  it('follows the active note: sections, collapsed state remembered, local graph with the graph settings', async () => {
    localStorage.clear();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.startsWith('/api/backlinks')) return Response.json({ linked: [], unlinked: [] });
        if (url === '/api/settings') return Response.json({ graph: { localDepth: 2 } });
        if (url === '/api/graph')
          return Response.json({
            nodes: [
              { id: 'Notiz.md', name: 'Notiz', kind: 'note', tags: [], folder: '', degree: 1 },
              { id: 'Nachbar.md', name: 'Nachbar', kind: 'note', tags: [], folder: '', degree: 1 },
              { id: 'Weit.md', name: 'Weit', kind: 'note', tags: [], folder: '', degree: 1 },
            ],
            links: [
              { source: 'Nachbar.md', target: 'Notiz.md' },
              { source: 'Nachbar.md', target: 'Weit.md' },
            ],
          });
        return new Response(null, { status: 404 });
      }),
    );
    workspace.open('Notiz.md');
    activeNote.set(fakeNote('---\na: 1\n---\n# Kopf\n'));
    render(RightPanel);
    expect(await screen.findByLabelText('Wert von a')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Kopf' })).toBeTruthy();
    expect(await screen.findByRole('button', { name: 'Nachbar' })).toBeTruthy();
    expect(await screen.findByRole('button', { name: 'Weit' })).toBeTruthy(); // localDepth 2 from the settings
    await fireEvent.click(screen.getByRole('button', { name: /Eigenschaften/ }));
    expect(screen.queryByLabelText('Wert von a')).toBeNull();
    expect(JSON.parse(localStorage.getItem('vw.rightPanel.collapsed')!)).toEqual(['properties']);
    workspace.close(0);
  });
});

import { get } from 'svelte/store';
import { beforeEach, describe, expect, it } from 'vitest';
import { createWorkspace, type Workspace } from '../../web/src/lib/stores/workspace';

/** In-memory Storage: each test starts empty; a second workspace on the same storage simulates a reload. */
function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() {
      return m.size;
    },
    clear: () => m.clear(),
    getItem: (k) => m.get(k) ?? null,
    key: (i) => [...m.keys()][i] ?? null,
    removeItem: (k) => void m.delete(k),
    setItem: (k, v) => void m.set(k, String(v)),
  };
}

let storage: Storage;
let ws: Workspace;
const state = () => get(ws);
const activeTab = () => state().tabs[state().active];

beforeEach(() => {
  storage = memoryStorage();
  ws = createWorkspace(storage);
});

describe('workspace: navigation', () => {
  it('opens the first path in a new tab', () => {
    ws.open('A.md');
    expect(state().tabs).toHaveLength(1);
    expect(activeTab()).toMatchObject({ kind: 'note', path: 'A.md', history: ['A.md'], pos: 0 });
  });

  it('open in the active tab appends to its history', () => {
    ws.open('A.md');
    ws.open('B.md');
    ws.open('C.md');
    expect(state().tabs).toHaveLength(1);
    expect(activeTab()).toMatchObject({ path: 'C.md', history: ['A.md', 'B.md', 'C.md'], pos: 2 });
  });

  it('back and forward move through the history and stop at its ends', () => {
    ws.open('A.md');
    ws.open('B.md');
    ws.open('C.md');
    ws.back();
    expect(activeTab()).toMatchObject({ path: 'B.md', pos: 1 });
    ws.back();
    ws.back();
    expect(activeTab()).toMatchObject({ path: 'A.md', pos: 0 });
    ws.forward();
    ws.forward();
    ws.forward();
    expect(activeTab()).toMatchObject({ path: 'C.md', pos: 2 });
  });

  it('open after back drops the forward history', () => {
    ws.open('A.md');
    ws.open('B.md');
    ws.back();
    ws.open('C.md');
    expect(activeTab()).toMatchObject({ path: 'C.md', history: ['A.md', 'C.md'], pos: 1 });
    ws.forward();
    expect(activeTab()!.path).toBe('C.md');
  });

  it('opening the current path again adds no history entry but keeps the subpath', () => {
    ws.open('A.md');
    ws.open('A.md', { subpath: '#Ziel' });
    expect(activeTab()).toMatchObject({ history: ['A.md'], pos: 0, subpath: '#Ziel' });
  });

  it('a line to reveal is a fresh, unsaved mark on every open (also for the current path)', () => {
    ws.open('A.md', { line: 4 });
    const first = activeTab()!.reveal;
    expect(first).toEqual({ line: 4 });
    ws.open('A.md', { line: 4 });
    expect(activeTab()!.reveal).toEqual({ line: 4 });
    expect(activeTab()!.reveal).not.toBe(first);
    ws.open('B.md');
    expect(activeTab()!.reveal).toBeUndefined();
    expect(storage.getItem('vw.workspace')).not.toContain('reveal');
  });

  it('newTab opens a new tab after the active one and activates it', () => {
    ws.open('A.md');
    ws.open('B.md', { newTab: true });
    expect(state().tabs.map((t) => t.path)).toEqual(['A.md', 'B.md']);
    expect(state().active).toBe(1);
    ws.activate(0);
    ws.open('C.md', { newTab: true });
    expect(state().tabs.map((t) => t.path)).toEqual(['A.md', 'C.md', 'B.md']);
    expect(state().active).toBe(1);
    expect(activeTab()!.history).toEqual(['C.md']);
  });

  it('derives the kind from the path: notes vs. other files', () => {
    ws.open('Bilder/Foto.PNG');
    expect(activeTab()!.kind).toBe('file');
    ws.open('Notiz.MD');
    expect(activeTab()!.kind).toBe('note');
    ws.back();
    expect(activeTab()!.kind).toBe('file');
  });

  it('openGraph opens one graph tab and reuses it; open() in it navigates to the note', () => {
    ws.open('A.md');
    ws.openGraph();
    expect(state().tabs).toHaveLength(2);
    expect(activeTab()).toMatchObject({ kind: 'graph', history: [], pos: -1 });
    expect(activeTab()!.path).toBeUndefined();
    ws.activate(0);
    ws.openGraph();
    expect(state().tabs).toHaveLength(2);
    expect(state().active).toBe(1);
    ws.open('B.md');
    expect(activeTab()).toMatchObject({ kind: 'note', path: 'B.md', history: ['B.md'], pos: 0 });
  });

  it('close removes the tab and keeps a sensible active tab', () => {
    ws.open('A.md');
    ws.open('B.md', { newTab: true });
    ws.open('C.md', { newTab: true });
    ws.close(2); // active, last
    expect(state().active).toBe(1);
    ws.activate(0);
    ws.close(1); // before nothing: active stays on A
    expect(state().tabs.map((t) => t.path)).toEqual(['A.md']);
    expect(state().active).toBe(0);
    ws.close(0);
    expect(state().tabs).toEqual([]);
    expect(state().active).toBe(-1);
  });

  it('closing a tab before the active one shifts the active index', () => {
    ws.open('A.md');
    ws.open('B.md', { newTab: true });
    ws.close(0);
    expect(state().active).toBe(0);
    expect(activeTab()!.path).toBe('B.md');
  });

  it('keeps the 20 most recent paths, newest first, without duplicates', () => {
    for (let i = 0; i < 25; i++) ws.open(`N${i}.md`);
    ws.open('N10.md');
    const { recent } = state();
    expect(recent).toHaveLength(20);
    expect(recent[0]).toBe('N10.md');
    expect(recent[1]).toBe('N24.md');
    expect(recent.filter((p) => p === 'N10.md')).toHaveLength(1);
  });
});

describe('workspace: vault events', () => {
  it('a renamed file updates open tabs, their history and recent', () => {
    ws.open('A.md');
    ws.open('B.md');
    ws.open('X.md', { newTab: true });
    ws.applyEvent({ seq: 1, type: 'renamed', from: 'A.md', to: 'Ordner/A2.md' });
    expect(state().tabs[0]).toMatchObject({ path: 'B.md', history: ['Ordner/A2.md', 'B.md'] });
    expect(state().recent).toContain('Ordner/A2.md');
    expect(state().recent).not.toContain('A.md');
    ws.applyEvent({ seq: 2, type: 'renamed', from: 'X.md', to: 'Y.md' });
    expect(activeTab()).toMatchObject({ path: 'Y.md', history: ['Y.md'] });
  });

  it('a renamed folder updates every path below it (prefix match), not look-alike siblings', () => {
    ws.open('Alt/Sub/A.md');
    ws.open('Alt/B.png');
    ws.open('Alter/C.md');
    ws.applyEvent({ seq: 1, type: 'renamed', from: 'Alt', to: 'Neu – Ordner' });
    expect(activeTab()!.history).toEqual(['Neu – Ordner/Sub/A.md', 'Neu – Ordner/B.png', 'Alter/C.md']);
    expect(activeTab()!.kind).toBe('note');
  });

  it('a rename can change the kind of the current entry', () => {
    ws.open('Text.md');
    ws.applyEvent({ seq: 1, type: 'renamed', from: 'Text.md', to: 'Text.txt' });
    expect(activeTab()).toMatchObject({ kind: 'file', path: 'Text.txt' });
  });

  it('deleted marks tabs showing the path (or a path below a deleted folder) as deleted', () => {
    ws.open('A.md');
    ws.open('Ordner/B.md', { newTab: true });
    ws.open('C.md', { newTab: true });
    ws.applyEvent({ seq: 1, type: 'deleted', path: 'A.md' });
    ws.applyEvent({ seq: 2, type: 'deleted', path: 'Ordner' });
    expect(state().tabs.map((t) => Boolean(t.deleted))).toEqual([true, true, false]);
    // The history keeps the path (it may come back); navigating away clears the mark.
    ws.activate(0);
    ws.open('D.md');
    expect(activeTab()!.deleted).toBeFalsy();
    ws.back();
    expect(activeTab()).toMatchObject({ path: 'A.md' });
  });

  it('created clears the deleted mark (e.g. an external atomic save: unlink + add)', () => {
    ws.open('A.md');
    ws.applyEvent({ seq: 1, type: 'deleted', path: 'A.md' });
    ws.applyEvent({ seq: 2, type: 'created', path: 'A.md' });
    expect(activeTab()!.deleted).toBeFalsy();
  });

  it('a renamed event clears the deleted mark of the tab it moves', () => {
    ws.open('A.md');
    ws.applyEvent({ seq: 1, type: 'deleted', path: 'A.md' });
    ws.applyEvent({ seq: 2, type: 'renamed', from: 'A.md', to: 'B.md' });
    expect(activeTab()).toMatchObject({ path: 'B.md' });
    expect(activeTab()!.deleted).toBeFalsy();
  });
});

describe('workspace: persistence', () => {
  it('restores tabs, history, active tab and recent after a reload', () => {
    ws.open('A.md');
    ws.open('B.md');
    ws.open('C.md', { newTab: true });
    ws.activate(0);
    const again = createWorkspace(storage);
    const s = get(again);
    expect(s.tabs.map((t) => t.history)).toEqual([['A.md', 'B.md'], ['C.md']]);
    expect(s.active).toBe(0);
    expect(s.recent).toEqual(['C.md', 'B.md', 'A.md']);
  });

  it('ignores broken or foreign data in storage', () => {
    storage.setItem('vw.workspace', '{kaputt');
    expect(get(createWorkspace(storage)).tabs).toEqual([]);
    storage.setItem('vw.workspace', JSON.stringify({ tabs: [{ kind: 'note', history: [1], pos: 9 }], active: 5, recent: 'x' }));
    const s = get(createWorkspace(storage));
    expect(s.tabs).toEqual([]);
    expect(s.active).toBe(-1);
    expect(s.recent).toEqual([]);
  });

  it('works without storage (blocked localStorage)', () => {
    const throwing = memoryStorage();
    throwing.setItem = () => {
      throw new Error('QuotaExceeded');
    };
    throwing.getItem = () => {
      throw new Error('SecurityError');
    };
    const w = createWorkspace(throwing);
    w.open('A.md');
    expect(get(w).tabs).toHaveLength(1);
  });
});

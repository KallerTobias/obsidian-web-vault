/// <reference lib="dom" />
import { CompletionContext, type CompletionResult } from '@codemirror/autocomplete';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { createFileLookup } from '@shared/resolve';
import { describe, expect, it } from 'vitest';
import type { LookupEntry } from '../../web/src/lib/api';
import { tagCompletions, wikilinkCompletions, type WikilinkSource } from '../../web/src/lib/editor/autocomplete';

const entries: LookupEntry[] = [
  { path: '00 - Übersicht.md', name: '00 - Übersicht', aliases: ['Index'], headings: [] },
  { path: 'Archiv/00 - Übersicht.md', name: '00 - Übersicht', aliases: [], headings: [] },
  {
    path: '00 - Startseite.md',
    name: '00 - Startseite',
    aliases: [],
    headings: [
      { level: 1, text: 'Start' },
      { level: 2, text: 'Bereiche' },
      { level: 2, text: 'Offene [Punkte]' },
    ],
  },
  { path: 'Projekte/Alpha Beta.md', name: 'Alpha Beta', aliases: ['AB'], headings: [] },
  { path: 'Projekte/Plan.md', name: 'Plan', aliases: [], headings: [{ level: 1, text: 'Plan' }] },
  { path: 'Bilder/foto.png', name: 'foto.png', aliases: [] },
];

const source = (format: WikilinkSource['format'] = 'shortest', sourcePath = 'Projekte/Plan.md'): WikilinkSource => ({
  entries,
  files: createFileLookup(entries.map((e) => e.path)),
  sourcePath,
  format,
});

/** Runs the source with the cursor at `|` in `doc`. */
function run(doc: string, fn: (ctx: CompletionContext) => CompletionResult | null | Promise<CompletionResult | null>) {
  const pos = doc.indexOf('|');
  const text = doc.replace('|', '').replaceAll('§', '|'); // § = a literal pipe
  const state = EditorState.create({ doc: text, selection: { anchor: pos } });
  return { state, result: fn(new CompletionContext(state, pos, false)) as CompletionResult | null };
}

function apply(state: EditorState, result: CompletionResult, label: string, detail?: string): string {
  const option = result.options.find((o) => o.label === label && (detail === undefined || o.detail === detail));
  if (!option) throw new Error(`no option ${label}: ${result.options.map((o) => o.label).join(', ')}`);
  const view = new EditorView({ state });
  const to = state.selection.main.head;
  if (typeof option.apply === 'function') option.apply(view, option, result.from, to);
  else view.dispatch({ changes: { from: result.from, to, insert: option.apply ?? option.label } });
  const out = view.state.sliceDoc();
  view.destroy();
  return out;
}

describe('wikilinkCompletions', () => {
  it('suggests notes by fuzzy, umlaut-insensitive match; same names show the path as detail', () => {
    const r = run('[[übers|', (c) => wikilinkCompletions(c, source())).result!;
    const hits = r.options.filter((o) => o.label === '00 - Übersicht');
    expect(hits.map((o) => o.detail).sort()).toEqual(['00 - Übersicht', 'Archiv/00 - Übersicht']);
    const r2 = run('[[UBERS|', (c) => wikilinkCompletions(c, source())).result!;
    expect(r2.options.filter((o) => o.label === '00 - Übersicht')).toHaveLength(2);
  });

  it('matches subsequences and prefers word starts', () => {
    const r = run('[[ab|', (c) => wikilinkCompletions(c, source())).result!;
    expect(r.options[0]!.label).toBe('AB'); // alias, exact
    expect(r.options.map((o) => o.label)).toContain('Alpha Beta');
  });

  it('inserts the shortest form, the path form on ambiguity, and closes the brackets', () => {
    const { state, result } = run('[[alpha|', (c) => wikilinkCompletions(c, source()));
    expect(apply(state, result!, 'Alpha Beta')).toBe('[[Alpha Beta]]');
    const amb = run('[[übers|', (c) => wikilinkCompletions(c, source()));
    expect(apply(amb.state, amb.result!, '00 - Übersicht', 'Archiv/00 - Übersicht')).toBe('[[Archiv/00 - Übersicht]]');
  });

  it('does not duplicate existing closing brackets', () => {
    const { state, result } = run('[[alpha|]] rest', (c) => wikilinkCompletions(c, source()));
    expect(apply(state, result!, 'Alpha Beta')).toBe('[[Alpha Beta]] rest');
  });

  it('honours the link format', () => {
    const abs = run('[[alpha|', (c) => wikilinkCompletions(c, source('absolute')));
    expect(apply(abs.state, abs.result!, 'Alpha Beta')).toBe('[[Projekte/Alpha Beta]]');
    const rel = run('[[start|', (c) => wikilinkCompletions(c, source('relative', 'Projekte/Plan.md')));
    expect(apply(rel.state, rel.result!, '00 - Startseite')).toBe('[[../00 - Startseite]]');
  });

  it('aliases insert [[Target|Alias]]', () => {
    const { state, result } = run('[[index|', (c) => wikilinkCompletions(c, source()));
    expect(apply(state, result!, 'Index')).toBe('[[00 - Übersicht|Index]]');
  });

  it('lists the headings of the note after [[Name#', () => {
    const { state, result } = run('[[00 - Startseite#|', (c) => wikilinkCompletions(c, source()));
    expect(result!.options.map((o) => o.label)).toEqual(['Start', 'Bereiche', 'Offene [Punkte]']);
    expect(apply(state, result!, 'Bereiche')).toBe('[[00 - Startseite#Bereiche]]');
    expect(apply(state, result!, 'Offene [Punkte]')).toBe('[[00 - Startseite#Offene Punkte]]');
  });

  it('filters headings by what was typed; [[# is the current note', () => {
    const r = run('[[00 - Startseite#ber|', (c) => wikilinkCompletions(c, source())).result!;
    expect(r.options.map((o) => o.label)).toEqual(['Bereiche']);
    const own = run('[[#pl|', (c) => wikilinkCompletions(c, source())).result!;
    expect(own.options.map((o) => o.label)).toEqual(['Plan']);
  });

  it('offers nothing after | or outside [[ ]], and limits to 50', () => {
    expect(run('[[Plan§x|', (c) => wikilinkCompletions(c, source())).result).toBeNull();
    expect(run('[[Plan§Ali|', (c) => wikilinkCompletions(c, source())).result).toBeNull();
    expect(run('Plan|', (c) => wikilinkCompletions(c, source())).result).toBeNull();
    expect(run('[[Plan]] und |', (c) => wikilinkCompletions(c, source())).result).toBeNull();
    const many: LookupEntry[] = Array.from({ length: 120 }, (_, i) => ({ path: `n${i}.md`, name: `n${i}`, aliases: [] }));
    const big: WikilinkSource = { ...source(), entries: many, files: createFileLookup(many.map((e) => e.path)) };
    expect(run('[[n|', (c) => wikilinkCompletions(c, big)).result!.options).toHaveLength(50);
  });
});

describe('tagCompletions', () => {
  const tags = ['nxtzlt', 'nxtlyr', 'projekt/alpha', 'ärger'];

  it('completes after # at a word start', () => {
    const { state, result } = run('Text #nx|', (c) => tagCompletions(c, tags));
    expect(result!.options.map((o) => o.label)).toEqual(['#nxtzlt', '#nxtlyr']);
    expect(apply(state, result!, '#nxtzlt')).toBe('Text #nxtzlt');
  });

  it('is accent-insensitive and matches nested tags', () => {
    expect(run('#arg|', (c) => tagCompletions(c, tags)).result!.options.map((o) => o.label)).toEqual(['#ärger']);
    expect(run('#alpha|', (c) => tagCompletions(c, tags)).result!.options.map((o) => o.label)).toEqual(['#projekt/alpha']);
  });

  it('stays quiet inside words, for headings and without a typed character', () => {
    expect(run('a#nx|', (c) => tagCompletions(c, tags)).result).toBeNull();
    expect(run('## Titel|', (c) => tagCompletions(c, tags)).result).toBeNull();
    expect(run('#|', (c) => tagCompletions(c, tags)).result).toBeNull();
    expect(run('# |', (c) => tagCompletions(c, tags)).result).toBeNull();
  });
});

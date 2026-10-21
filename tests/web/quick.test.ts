import { describe, expect, it } from 'vitest';
import type { LookupEntry } from '../../web/src/lib/api';
import { quickMatches } from '../../web/src/lib/quick';

const entries: LookupEntry[] = [
  { path: '00 - Übersicht.md', name: '00 - Übersicht', aliases: ['Index'] },
  { path: 'Projekte/Alpha Beta.md', name: 'Alpha Beta', aliases: ['AB'] },
  { path: 'Projekte/Plan.md', name: 'Plan', aliases: [] },
  { path: 'Archiv/Plan alt.md', name: 'Plan alt', aliases: [] },
  { path: 'Bilder/foto.png', name: 'foto.png', aliases: [] },
];

describe('quickMatches', () => {
  it('finds notes fuzzily (umlauts, case) and ignores other files', () => {
    expect(quickMatches(entries, 'ubers', []).map((m) => m.path)).toEqual(['00 - Übersicht.md']);
    expect(quickMatches(entries, 'foto', [])).toEqual([]);
  });

  it('ranks the better name first', () => {
    expect(quickMatches(entries, 'plan', []).map((m) => m.path)).toEqual(['Projekte/Plan.md', 'Archiv/Plan alt.md']);
  });

  it('finds notes by alias and says so', () => {
    const [m] = quickMatches(entries, 'index', []);
    expect(m).toMatchObject({ path: '00 - Übersicht.md', alias: 'Index', name: '00 - Übersicht' });
  });

  it('matches the folder as a weaker hint', () => {
    expect(quickMatches(entries, 'archiv', []).map((m) => m.path)).toEqual(['Archiv/Plan alt.md']);
  });

  it('lists recent notes first for an empty query, then the rest by name', () => {
    const out = quickMatches(entries, '', ['Projekte/Plan.md', 'weg.md', 'Archiv/Plan alt.md']).map((m) => m.path);
    expect(out).toEqual(['Projekte/Plan.md', 'Archiv/Plan alt.md', '00 - Übersicht.md', 'Projekte/Alpha Beta.md']);
  });

  it('caps the list', () => {
    const many = Array.from({ length: 200 }, (_, i): LookupEntry => ({ path: `n${i}.md`, name: `n${i}`, aliases: [] }));
    expect(quickMatches(many, 'n', [], 50)).toHaveLength(50);
  });
});

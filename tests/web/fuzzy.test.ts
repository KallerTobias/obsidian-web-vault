import { describe, expect, it } from 'vitest';
import { fuzzyScore } from '../../web/src/lib/fuzzy';

describe('fuzzyScore', () => {
  it('matches regardless of umlauts and case', () => {
    expect(fuzzyScore('übs', '00 - Übersicht')).toBeGreaterThan(0);
    expect(fuzzyScore('UBERSICHT', '00 - Übersicht')).toBeGreaterThan(0);
    expect(fuzzyScore('ubersicht', '00 - Übersicht')).toBeGreaterThan(0); // NFD name
  });

  it('returns null without a match', () => {
    expect(fuzzyScore('xyz', '00 - Übersicht')).toBeNull();
    expect(fuzzyScore('tsb', 'Beta')).toBeNull();
  });

  it('prefers word starts over the middle', () => {
    expect(fuzzyScore('plan', 'Projekt Plan')!).toBeGreaterThan(fuzzyScore('plan', 'Explanation')!);
    expect(fuzzyScore('plan', 'Plan Projekt')!).toBeGreaterThan(fuzzyScore('plan', 'Projekt Plan')!);
  });

  it('accepts scattered letters, ranked below contiguous matches', () => {
    const scattered = fuzzyScore('abe', 'Alpha Beta')!;
    expect(scattered).toBeGreaterThan(0);
    expect(fuzzyScore('alp', 'Alpha Beta')!).toBeGreaterThan(scattered);
  });

  it('matches everything for an empty query', () => {
    expect(fuzzyScore('', 'Irgendwas')).toBeGreaterThan(0);
  });
});

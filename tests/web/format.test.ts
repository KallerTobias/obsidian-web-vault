import { afterEach, describe, expect, it, vi } from 'vitest';

const at = new Date(2026, 9, 19, 14, 30).getTime();

describe('locale-dependent formatting follows the UI language', () => {
  afterEach(() => {
    vi.doUnmock('../../web/src/lib/i18n');
    vi.resetModules();
  });

  async function withLanguage(lang: string) {
    vi.resetModules();
    vi.doMock('../../web/src/lib/i18n', async (orig) => ({ ...(await orig<object>()), lang }));
    return { format: await import('../../web/src/lib/format') };
  }

  it('German dates', async () => {
    const { format } = await withLanguage('de');
    expect(format.formatDateTime(at)).toBe('19.10.2026, 14:30');
  });

  it('English dates', async () => {
    const { format } = await withLanguage('en');
    expect(format.formatDateTime(at)).toBe('Oct 19, 2026, 2:30 PM');
  });

  it('French dates', async () => {
    const { format } = await withLanguage('fr');
    expect(format.formatDateTime(at)).toBe(new Date(at).toLocaleString('fr', { dateStyle: 'medium', timeStyle: 'short' }));
    expect(format.formatDateTime(at)).toContain('oct.');
  });
});

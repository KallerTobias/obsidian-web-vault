/// <reference lib="dom" />
/// <reference types="svelte" />
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import LanguageSelect from '../../../web/src/components/LanguageSelect.svelte';
import SettingsView from '../../../web/src/components/SettingsView.svelte';
import * as i18n from '../../../web/src/lib/i18n';
import { de } from '../../../web/src/lib/i18n/de';

// The real reload is replaced (jsdom cannot navigate); everything else of the module stays real.
vi.mock('../../../web/src/lib/i18n', async (orig) => {
  const mod = await orig<typeof import('../../../web/src/lib/i18n')>();
  return { ...mod, setLanguagePreference: vi.fn(async () => {}) };
});

let puts: unknown[];

beforeEach(() => {
  puts = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      if (url === '/api/settings' && init.method === 'PUT') {
        puts.push(JSON.parse(String(init.body)));
        return Response.json({});
      }
      if (url === '/api/settings') {
        return Response.json({
          attachmentFolder: '',
          newLinkFormat: 'shortest',
          newNoteFolder: '',
          templatesFolder: '',
          theme: 'system',
          dailyNotes: { enabled: false, folder: '', format: 'YYYY-MM-DD', template: '' },
          graph: { mode: '2d' },
        });
      }
      if (url === '/api/auth/passkeys' || url === '/api/auth/sessions') return Response.json([]);
      return new Response(null, { status: 204 });
    }),
  );
  localStorage.removeItem('vw-language');
  vi.mocked(i18n.setLanguagePreference).mockClear();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('LanguageSelect', () => {
  it('offers auto (naming the browser language) and the five languages by their native names', () => {
    render(LanguageSelect);
    const select = screen.getByRole('combobox', { name: de.settings.language.label }) as HTMLSelectElement;
    const options = [...select.options].map((o) => [o.value, o.textContent]);
    // jsdom's browser language is en-US.
    expect(options).toEqual([
      ['auto', de.settings.language.auto('English')],
      ['de', 'Deutsch'],
      ['en', 'English'],
      ['es', 'Español'],
      ['fr', 'Français'],
      ['it', 'Italiano'],
    ]);
    expect(select.value).toBe('auto');
  });

  it('shows the stored preference and stores a new choice (which reloads)', async () => {
    localStorage.setItem('vw-language', 'fr');
    render(LanguageSelect);
    const select = screen.getByRole('combobox') as HTMLSelectElement;
    expect(select.value).toBe('fr');
    await fireEvent.change(select, { target: { value: 'it' } });
    expect(i18n.setLanguagePreference).toHaveBeenCalledWith('it');
  });
});

describe('SettingsView language section', () => {
  it('is the first section and works before the server settings are loaded', async () => {
    render(SettingsView);
    const headings = screen.getAllByRole('heading', { level: 3 });
    expect(headings[0]!.textContent).toBe(de.settings.language.heading);
    const select = screen.getByLabelText(de.settings.language.label);
    expect(select.getAttribute('aria-describedby')).toBeTruthy();
    expect(document.getElementById(select.getAttribute('aria-describedby')!)!.textContent).toBe(de.settings.language.hint);
  });

  it('a settings change still waiting is sent before the language reload', async () => {
    render(SettingsView);
    const input = (await screen.findByLabelText(de.settings.files.newNoteFolder)) as HTMLInputElement;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await fireEvent.input(input, { target: { value: 'Neu' } });
    expect(puts).toHaveLength(0);
    const actual = await vi.importActual<typeof import('../../../web/src/lib/i18n')>('../../../web/src/lib/i18n');
    const reload = vi.fn(() => expect(puts).toEqual([{ newNoteFolder: 'Neu' }]));
    await actual.setLanguagePreference('en', reload);
    expect(reload).toHaveBeenCalledOnce();
  });
});

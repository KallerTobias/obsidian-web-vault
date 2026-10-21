import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LANGUAGES,
  beforeLanguageReload,
  getLanguagePreference,
  lang,
  resolveLanguage,
  setLanguagePreference,
  t,
} from '../../web/src/lib/i18n';
import { de } from '../../web/src/lib/i18n/de';

describe('resolveLanguage', () => {
  it('a stored language wins over the browser', () => {
    expect(resolveLanguage('fr', ['de-DE', 'en'])).toBe('fr');
    expect(resolveLanguage('de', ['en-US'])).toBe('de');
  });

  it('auto (or nothing stored) takes the first supported browser language by its primary subtag', () => {
    expect(resolveLanguage('auto', ['de-AT', 'en'])).toBe('de');
    expect(resolveLanguage(null, ['fr-CA'])).toBe('fr');
    expect(resolveLanguage('auto', ['ja-JP', 'IT-ch', 'de'])).toBe('it');
    expect(resolveLanguage('auto', ['es'])).toBe('es');
  });

  it('falls back to English when no browser language is supported', () => {
    expect(resolveLanguage('auto', ['ja-JP', 'zh'])).toBe('en');
    expect(resolveLanguage(null, [])).toBe('en');
  });

  it('an invalid stored value counts as auto', () => {
    expect(resolveLanguage('xx', ['it-IT'])).toBe('it');
    expect(resolveLanguage('', ['de'])).toBe('de');
    expect(resolveLanguage('DE', ['ja'])).toBe('en');
  });
});

describe('language preference', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('lists the five languages by their native names', () => {
    expect(LANGUAGES.map((l) => l.code)).toEqual(['de', 'en', 'es', 'fr', 'it']);
    expect(LANGUAGES.map((l) => l.name)).toEqual(['Deutsch', 'English', 'Español', 'Français', 'Italiano']);
  });

  it('reads the stored preference; missing or invalid is auto', () => {
    expect(getLanguagePreference()).toBe('auto');
    localStorage.setItem('vw-language', 'es');
    expect(getLanguagePreference()).toBe('es');
    localStorage.setItem('vw-language', 'klingon');
    expect(getLanguagePreference()).toBe('auto');
  });

  it('blocked storage reads as auto', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(getLanguagePreference()).toBe('auto');
  });

  it('waits for the registered savers, then stores the choice and reloads', async () => {
    const order: string[] = [];
    let release!: () => void;
    const off = beforeLanguageReload(
      () =>
        new Promise<void>((resolve) => {
          order.push('flush started');
          release = () => {
            order.push('flush done');
            resolve();
          };
        }),
    );
    const reload = vi.fn(() => order.push(`reload (stored: ${localStorage.getItem('vw-language')})`));
    const done = setLanguagePreference('fr', reload);
    await Promise.resolve();
    // Not stored yet: a page closed while saving keeps its language.
    expect(localStorage.getItem('vw-language')).toBeNull();
    expect(reload).not.toHaveBeenCalled();
    release();
    await done;
    expect(order).toEqual(['flush started', 'flush done', 'reload (stored: fr)']);
    expect(getLanguagePreference()).toBe('fr');
    off();
  });

  it('marks the page as reloading for the language only when the reload starts', async () => {
    vi.resetModules();
    const pageLang = document.documentElement.lang;
    const fresh = await import('../../web/src/lib/i18n');
    document.documentElement.lang = pageLang; // the fresh module sets it on import
    let release!: () => void;
    const off = fresh.beforeLanguageReload(() => new Promise<void>((resolve) => (release = resolve)));
    const reload = vi.fn(() => expect(fresh.isLanguageReload()).toBe(true));
    const done = fresh.setLanguagePreference('it', reload);
    await Promise.resolve();
    expect(fresh.isLanguageReload()).toBe(false);
    release();
    await done;
    expect(reload).toHaveBeenCalledOnce();
    off();
  });

  it('a failing saver does not stop the reload; an unregistered one is not called', async () => {
    const off1 = beforeLanguageReload(() => Promise.reject(new Error('offline')));
    const gone = vi.fn();
    const off2 = beforeLanguageReload(gone);
    off2();
    const reload = vi.fn();
    await setLanguagePreference('auto', reload);
    expect(reload).toHaveBeenCalledOnce();
    expect(gone).not.toHaveBeenCalled();
    expect(localStorage.getItem('vw-language')).toBe('auto');
    off1();
  });

  it('a hanging saver does not block the reload forever', async () => {
    vi.useFakeTimers();
    try {
      const off = beforeLanguageReload(() => new Promise<void>(() => {}));
      const reload = vi.fn();
      const done = setLanguagePreference('de', reload);
      await vi.advanceTimersByTimeAsync(10_000);
      await done;
      expect(reload).toHaveBeenCalledOnce();
      off();
    } finally {
      vi.useRealTimers();
    }
  });

  it('blocked storage still reloads (the page then stays on auto)', async () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const reload = vi.fn();
    await setLanguagePreference('it', reload);
    expect(reload).toHaveBeenCalledOnce();
  });

  it('the page language follows the resolved language (tests run in German, see setup.ts)', () => {
    expect(lang).toBe('de');
    expect(document.documentElement.lang).toBe('de');
    expect(t).toBe(de);
  });
});

describe('packs', () => {
  it('every pack is importable and has the shape of the German one', async () => {
    for (const code of ['en', 'es', 'fr', 'it']) {
      const mod = (await import(`../../web/src/lib/i18n/${code}.ts`)) as Record<string, unknown>;
      const pack = mod[code] as Record<string, unknown>;
      expect(Object.keys(pack).sort()).toEqual(Object.keys(de).sort());
    }
  });
});

describe('no direct import of the German pack', () => {
  // jsdom's import.meta.url is not a file URL; vitest runs from the repo root.
  const root = join(process.cwd(), 'web/src');
  const allowed = new Set(['lib/i18n/index.ts', 'lib/i18n/en.ts', 'lib/i18n/es.ts', 'lib/i18n/fr.ts', 'lib/i18n/it.ts']);

  /** A static (`from '…/i18n/de'`) or dynamic (`import('…/i18n/de')`) import of the German pack. */
  const importsGerman =
    /from\s+['"][^'"]*i18n\/de(\.ts)?['"]|from\s+['"]\.\/de(\.ts)?['"]|import\(\s*['"][^'"]*(i18n\/|\.\/)de(\.ts)?['"]/;

  it('the check catches static and dynamic imports', () => {
    for (const code of [
      "import { de } from '../lib/i18n/de';",
      'import { de } from "./i18n/de.ts";',
      "import { de } from './de';",
      "const { de } = await import('../lib/i18n/de');",
      'const m = import( "./de" );',
    ]) {
      expect(importsGerman.test(code), code).toBe(true);
    }
    for (const code of ["import { t } from '../lib/i18n';", "import x from './demo';", "await import('../lib/i18n')"]) {
      expect(importsGerman.test(code), code).toBe(false);
    }
  });

  function files(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const p = join(dir, name);
      return statSync(p).isDirectory() ? files(p) : /\.(ts|svelte)$/.test(name) ? [p] : [];
    });
  }

  it('only the i18n index and the packs import i18n/de; everything else uses `t`', () => {
    const offenders = files(root)
      .map((p) => relative(root, p).split('\\').join('/'))
      .filter((rel) => !allowed.has(rel) && rel !== 'lib/i18n/de.ts')
      .filter((rel) => importsGerman.test(readFileSync(join(root, rel), 'utf8')));
    expect(offenders).toEqual([]);
  });
});

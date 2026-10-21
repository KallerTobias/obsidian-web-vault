// @vitest-environment jsdom
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { get } from 'svelte/store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api } from '../../web/src/lib/api';
import { de } from '../../web/src/lib/i18n/de';
import { en } from '../../web/src/lib/i18n/en';
import { es } from '../../web/src/lib/i18n/es';
import { fr } from '../../web/src/lib/i18n/fr';
import { it as itPack } from '../../web/src/lib/i18n/it';
import { session } from '../../web/src/lib/stores/session';

type Call = { url: string; init: RequestInit };

/** Quoted UPPER_CASE literals in the server's HTTP layer that are not error codes for the client. */
const NOT_CLIENT_CODES = new Set([
  'GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', // HTTP methods
  'OUTSIDE', // PathError code, answered as INVALID_PATH
]);

/**
 * Every error code the server can send: all quoted UPPER_CASE literals in server/http/** (so a new
 * code fails here until it is translated, or listed above when it is not a client code).
 */
function serverErrorCodes(): string[] {
  const dir = join(process.cwd(), 'server/http');
  const sources = readdirSync(dir, { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith('.ts'));
  const codes = new Set<string>();
  for (const f of sources) {
    for (const m of readFileSync(join(dir, f), 'utf8').matchAll(/'([A-Z][A-Z0-9_]{2,})'/g)) codes.add(m[1]!);
  }
  return [...codes].filter((c) => !NOT_CLIENT_CODES.has(c)).sort();
}
let calls: Call[];

function respond(status: number, body?: unknown): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      calls.push({ url, init });
      const text = body === undefined ? null : JSON.stringify(body);
      return new Response(text, {
        status,
        headers: text === null ? {} : { 'content-type': 'application/json; charset=utf-8' },
      });
    }),
  );
}

beforeEach(() => {
  calls = [];
  session.expired.set(false);
});
afterEach(() => vi.unstubAllGlobals());

describe('api', () => {
  it('encodes paths as one query component', async () => {
    respond(200, { content: 'x', version: 'v1', readonly: false });
    await api.note.get('a/b #c.md');
    expect(calls[0]!.url).toBe('/api/note?path=a%2Fb%20%23c.md');
    expect(calls[0]!.init.method ?? 'GET').toBe('GET');
  });

  it('sends a save as PUT with JSON body and returns the new version', async () => {
    respond(200, { version: 'v2' });
    const r = await api.note.save('Ordner/Notiz (1)?.md', 'Hallo', 'v1');
    expect(r).toEqual({ version: 'v2' });
    expect(calls[0]!.url).toBe('/api/note?path=Ordner%2FNotiz%20(1)%3F.md');
    expect(calls[0]!.init.method).toBe('PUT');
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ content: 'Hallo', baseVersion: 'v1' });
    expect(new Headers(calls[0]!.init.headers).get('content-type')).toBe('application/json');
  });

  it('throws ApiError with the conflict body on 409', async () => {
    respond(409, { error: 'Konflikt', diskContent: 'auf der Platte', diskVersion: 'v9' });
    const err = await api.note.save('a.md', 'mein Text', 'v1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(409);
    expect((err as ApiError).body).toMatchObject({ diskContent: 'auf der Platte', diskVersion: 'v9' });
    expect(get(session.expired)).toBe(false);
  });

  it('marks the session as expired on 401', async () => {
    respond(401, { error: 'Nicht angemeldet' });
    await expect(api.tree()).rejects.toMatchObject({ status: 401 });
    expect(get(session.expired)).toBe(true);
  });

  it('does not treat a failed login ceremony as an expired session', async () => {
    respond(401, { error: 'Anmeldung fehlgeschlagen' });
    await expect(api.auth.loginVerify('c1', { id: 'x' })).rejects.toMatchObject({ status: 401 });
    expect(get(session.expired)).toBe(false);
  });

  it('returns undefined for 204 responses', async () => {
    respond(204);
    await expect(api.entry.trash('Ordner/x.md')).resolves.toBeUndefined();
    expect(calls[0]!.url).toBe('/api/entry?path=Ordner%2Fx.md');
    expect(calls[0]!.init.method).toBe('DELETE');
  });

  it('keeps a non-JSON error body as text', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('Bad Gateway', { status: 502 })));
    await expect(api.tree()).rejects.toMatchObject({ status: 502, body: 'Bad Gateway' });
  });
});

describe('ApiError', () => {
  it('exposes the server code and shows the translated text for it', async () => {
    respond(403, { error: 'Pfad ist schreibgeschützt', code: 'READONLY' });
    const err = (await api.note.save('a.md', 'x', 'v1').catch((e) => e)) as ApiError;
    expect(err.code).toBe('READONLY');
    expect(err.serverMessage).toBe('Pfad ist schreibgeschützt');
    expect(err.message).toBe(de.errors.READONLY);
  });

  it('uses the pack of the current language, not the server text', async () => {
    vi.resetModules();
    vi.doMock('../../web/src/lib/i18n', async (orig) => {
      const mod = await orig<typeof import('../../web/src/lib/i18n')>();
      return { ...mod, t: { ...mod.t, errors: { ...mod.t.errors, CONFLICT: 'Conflict: the file changed' } } };
    });
    try {
      const { ApiError: Fresh } = await import('../../web/src/lib/api');
      const err = new Fresh(409, { error: 'Konflikt: Datei wurde zwischenzeitlich geändert', code: 'CONFLICT' });
      expect(err.message).toBe('Conflict: the file changed');
      expect(err.serverMessage).toBe('Konflikt: Datei wurde zwischenzeitlich geändert');
    } finally {
      vi.doUnmock('../../web/src/lib/i18n');
      vi.resetModules();
    }
  });

  it('falls back to the server text for unknown codes and to the status without a body', () => {
    expect(new ApiError(400, { error: 'Etwas Neues', code: 'SOMETHING_NEW' }).message).toBe('Etwas Neues');
    // Only server codes are looked up, never the client's own keys of `errors`.
    expect(new ApiError(400, { error: 'Server', code: 'unexpected' }).message).toBe('Server');
    expect(new ApiError(400, { error: 'Alt' }).code).toBeUndefined();
    expect(new ApiError(400, { error: 'Alt' }).message).toBe('Alt');
    expect(new ApiError(502, 'Bad Gateway').message).toBe('HTTP 502');
    expect(new ApiError(502, undefined).code).toBeUndefined();
  });

  it('every language pack has a translation for every code the server sends', () => {
    const codes = serverErrorCodes();
    // Sanity check of the extraction: codes from `code:` bodies, HttpError calls (also multi-line) and maps.
    for (const c of ['NOT_FOUND', 'TOO_MANY_STREAMS', 'TOO_MANY_REQUESTS', 'NOT_UTF8', 'PASSKEY_NOT_FOUND', 'STEP_UP']) {
      expect(codes).toContain(c);
    }
    for (const [name, pack] of Object.entries({ de, en, es, fr, it: itPack })) {
      const errors = pack.errors as Record<string, unknown>;
      expect(codes.filter((c) => typeof errors[c] !== 'string'), name).toEqual([]);
    }
  });
});

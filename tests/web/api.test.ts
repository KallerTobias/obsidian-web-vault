// @vitest-environment jsdom
import { get } from 'svelte/store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api } from '../../web/src/lib/api';
import { session } from '../../web/src/lib/stores/session';

type Call = { url: string; init: RequestInit };
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

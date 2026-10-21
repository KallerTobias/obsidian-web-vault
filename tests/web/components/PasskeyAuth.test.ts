/// <reference lib="dom" />
/// <reference types="svelte" />
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const webauthn = vi.hoisted(() => ({
  startAuthentication: vi.fn(),
  startRegistration: vi.fn(),
}));
vi.mock('@simplewebauthn/browser', () => ({
  browserSupportsWebAuthn: () => true,
  browserSupportsWebAuthnAutofill: async () => false,
  WebAuthnAbortService: { cancelCeremony: () => {} },
  startAuthentication: webauthn.startAuthentication,
  startRegistration: webauthn.startRegistration,
}));

import Login from '../../../web/src/components/Login.svelte';
import PasskeyList from '../../../web/src/components/PasskeyList.svelte';
import Setup from '../../../web/src/components/Setup.svelte';
import { de } from '../../../web/src/lib/i18n/de';

let calls: { url: string; method: string; body?: any }[];
let answers: Record<string, () => Response>;

beforeEach(() => {
  calls = [];
  answers = {};
  webauthn.startAuthentication.mockReset().mockResolvedValue({ id: 'p1', assertion: true });
  webauthn.startRegistration.mockReset().mockResolvedValue({ id: 'p2', attestation: true });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? 'GET';
      calls.push({ url, method, body: init.body ? JSON.parse(String(init.body)) : undefined });
      const a = answers[`${method} ${url}`];
      if (a) return a();
      if (url === '/api/auth/passkeys' && method === 'GET') {
        return Response.json([{ id: 'p1', name: 'Mac', transports: [], createdAt: 1, lastUsed: null }]);
      }
      if (url === '/api/auth/passkeys/confirm/options') return Response.json({ options: { challenge: 'c1' }, challengeId: 'k1' });
      if (url === '/api/auth/passkeys/confirm') return Response.json({ ok: true });
      if (url === '/api/auth/passkeys/options') return Response.json({ options: { challenge: 'c2' }, challengeId: 'k2' });
      if (url === '/api/auth/passkeys' && method === 'POST') return Response.json({ id: 'p2', name: 'Neu' });
      return new Response(null, { status: 404 });
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('PasskeyList: adding needs a confirmation with an existing passkey', () => {
  it('runs the confirmation (authentication) before the registration', async () => {
    render(PasskeyList);
    await screen.findByText('Mac');
    expect(screen.getByText(de.settings.passkeys.addHint)).toBeTruthy();
    await fireEvent.click(screen.getByRole('button', { name: de.settings.passkeys.add }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.url === '/api/auth/passkeys')).toBe(true));
    const posts = calls.filter((c) => c.method === 'POST').map((c) => c.url);
    expect(posts).toEqual([
      '/api/auth/passkeys/confirm/options',
      '/api/auth/passkeys/confirm',
      '/api/auth/passkeys/options',
      '/api/auth/passkeys',
    ]);
    expect(webauthn.startAuthentication).toHaveBeenCalledWith({ optionsJSON: { challenge: 'c1' } });
    expect(calls.find((c) => c.url === '/api/auth/passkeys/confirm')!.body).toEqual({
      challengeId: 'k1',
      response: { id: 'p1', assertion: true },
    });
    expect(webauthn.startAuthentication.mock.invocationCallOrder[0]!).toBeLessThan(
      webauthn.startRegistration.mock.invocationCallOrder[0]!,
    );
  });

  it('a failed confirmation stops before the registration with a clear message', async () => {
    answers['POST /api/auth/passkeys/confirm'] = () => Response.json({ error: 'Bestätigung fehlgeschlagen' }, { status: 401 });
    render(PasskeyList);
    await screen.findByText('Mac');
    await fireEvent.click(screen.getByRole('button', { name: de.settings.passkeys.add }));
    expect(await screen.findByText(de.errors.confirmFailed)).toBeTruthy();
    expect(webauthn.startRegistration).not.toHaveBeenCalled();
    expect(calls.some((c) => c.url === '/api/auth/passkeys/options')).toBe(false);
  });

  it('shows the step-up hint while confirming', async () => {
    let release!: (v: unknown) => void;
    webauthn.startAuthentication.mockReturnValue(new Promise((r) => (release = r)));
    render(PasskeyList);
    await screen.findByText('Mac');
    await fireEvent.click(screen.getByRole('button', { name: de.settings.passkeys.add }));
    expect(await screen.findByText(de.settings.passkeys.confirming)).toBeTruthy();
    release({ id: 'p1' });
  });
});

describe('wrong origin (page not under PUBLIC_URL)', () => {
  it('Login shows a pointer to the configured address instead of the button', async () => {
    render(Login, { onSuccess: () => {}, publicOrigin: 'https://vault.example.com' });
    expect(screen.getByText(de.origin.text('https://vault.example.com'))).toBeTruthy();
    expect(screen.getByRole('link', { name: de.origin.link }).getAttribute('href')).toBe('https://vault.example.com/');
    expect(screen.queryByRole('button', { name: de.login.button })).toBeNull();
  });

  it('Login under the right origin shows the button', async () => {
    render(Login, { onSuccess: () => {}, publicOrigin: location.origin });
    expect(screen.getByRole('button', { name: de.login.button })).toBeTruthy();
    expect(screen.queryByText(de.origin.title)).toBeNull();
  });

  it('Login maps the server\'s Origin refusal (403 ORIGIN) to the notice', async () => {
    answers['POST /api/auth/login/options'] = () =>
      Response.json({ error: 'Anfrage von fremder Herkunft abgelehnt', code: 'ORIGIN' }, { status: 403 });
    render(Login, { onSuccess: () => {} });
    await fireEvent.click(screen.getByRole('button', { name: de.login.button }));
    expect(await screen.findByText(de.origin.title)).toBeTruthy();
    expect(screen.queryByRole('button', { name: de.login.button })).toBeNull();
  });

  it('Setup keeps the token in the link to the configured address', async () => {
    history.replaceState(null, '', '/setup#tok123');
    render(Setup, { onSuccess: () => {}, publicOrigin: 'https://vault.example.com' });
    expect(screen.getByRole('link', { name: de.origin.link }).getAttribute('href')).toBe('https://vault.example.com/setup#tok123');
    expect(screen.queryByRole('button', { name: de.setup.button })).toBeNull();
    history.replaceState(null, '', '/');
  });

  it('Setup maps the Origin refusal to the notice', async () => {
    history.replaceState(null, '', '/setup#tok123');
    answers['POST /api/auth/setup/options'] = () =>
      Response.json({ error: 'Anfrage von fremder Herkunft abgelehnt', code: 'ORIGIN' }, { status: 403 });
    render(Setup, { onSuccess: () => {} });
    await fireEvent.click(screen.getByRole('button', { name: de.setup.button }));
    expect(await screen.findByText(de.origin.title)).toBeTruthy();
    expect(screen.queryByText(de.errors.setupDenied)).toBeNull();
    history.replaceState(null, '', '/');
  });
});

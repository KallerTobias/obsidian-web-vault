import { expect, openNote, test } from './fixtures';

test('ohne Anmeldung liefern die Vault-Routen 401', async ({ request, server }) => {
  const paths = [
    '/api/tree',
    `/api/file?path=${encodeURIComponent('Bilder/Foto 1.png')}`,
    `/api/file?path=${encodeURIComponent('Bilder/Handbuch.pdf')}`,
    `/api/note?path=${encodeURIComponent('00 Start.md')}`,
    '/api/search?q=Start',
    '/api/graph',
    '/api/settings',
    '/api/auth/passkeys',
    '/api/auth/sessions',
  ];
  for (const path of paths) {
    const res = await request.get(`${server.url}${path}`);
    expect(res.status(), path).toBe(401);
  }
  expect((await request.get(`${server.url}/api/health`)).status()).toBe(200);
});

test('die App-Seite hat die strenge CSP', async ({ request, server }) => {
  const res = await request.get(`${server.url}/`, { headers: { accept: 'text/html' } });
  expect(res.status()).toBe(200);
  const csp = res.headers()['content-security-policy'] ?? '';
  expect(csp).toContain("script-src 'self'");
  expect(csp).toContain("frame-ancestors 'none'");
  expect(csp).not.toContain('unsafe-eval');
});

test('schreibende Anfragen von fremder Herkunft werden abgelehnt, die eigene Herkunft nicht', async ({ authed, server }) => {
  // Positive control: the same request from the app's own origin is accepted.
  const ok = await authed.request.post(`${server.url}/api/note`, {
    headers: { origin: server.url },
    data: { path: 'Eigen.md', content: 'x' },
  });
  expect(ok.status()).toBeLessThan(300);
  expect(await server.list()).toContain('Eigen.md');

  const res = await authed.request.post(`${server.url}/api/note`, {
    headers: { origin: 'https://evil.example' },
    data: { path: 'Fremd.md', content: 'x' },
  });
  expect(res.status()).toBe(403);
  expect(await server.list()).not.toContain('Fremd.md');
});

test('bösartiges HTML in einer Notiz wird nicht ausgeführt', async ({ authed: page, problems }) => {
  page.on('dialog', (d) => {
    problems.dialogs.push(d.message());
    void d.dismiss();
  });
  await openNote(page, 'Sicherheit/Böse.md');

  for (const mode of ['Lesen', 'Bearbeiten']) {
    await page.getByRole('button', { name: mode, exact: true }).click();
    const root = mode === 'Lesen' ? page.locator('.reading-view') : page.locator('.note-view .cm-content');
    await expect(root.getByRole('heading', { name: 'Böse' }).or(root.getByText('Böse')).first()).toBeVisible();
    // The sanitizer drops event handlers, scripts, frames and `javascript:` URLs.
    await expect(page.locator('[onerror], [onclick], .note-view script, .note-view iframe')).toHaveCount(0);
    await expect(page.locator('.note-view a[href^="javascript:" i]')).toHaveCount(0);
  }

  await page.getByRole('button', { name: 'Lesen', exact: true }).click();
  const link = page.locator('.reading-view').getByText('Gefährlicher Link');
  await expect(link).toBeVisible();
  const url = page.url();
  await link.click();
  await page.locator('.reading-view').getByText('Markdown-Link').click();
  await page.locator('.reading-view').getByText('Klick mich').click();
  // Give a (wrongly) scheduled handler a chance to run: one round trip to the server.
  await page.evaluate(() => fetch('/api/health'));
  expect(page.url()).toBe(url);
  expect(problems.dialogs).toEqual([]);
});

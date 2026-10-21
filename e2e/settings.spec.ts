import type { Page } from '@playwright/test';
import { addAuthenticator, authenticatorOf, expect, openNote, test } from './fixtures';

async function openSettings(page: Page): Promise<void> {
  await page.keyboard.press('ControlOrMeta+p');
  await page.getByRole('dialog', { name: 'Befehlspalette' }).getByRole('combobox').fill('Einstellungen');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Einstellungen', level: 2 })).toBeVisible();
}

const passkeys = (page: Page) => page.getByRole('region', { name: 'Einstellungen' }).locator('section', { has: page.getByRole('heading', { name: 'Passkeys' }) });

test('zweiten Passkey hinzufügen und wieder entfernen', async ({ authed: page }) => {
  await openSettings(page);
  const section = passkeys(page);
  await expect(section.getByRole('listitem')).toHaveCount(1);

  // Adding first asks for a confirmation with the existing passkey (step-up, user verification
  // required), then registers the new one. The new one comes from a second device: once the
  // confirmation is through (the registration options are requested), the first authenticator,
  // which holds the excluded existing credential, is swapped for another one.
  const first = authenticatorOf(page);
  let second: Awaited<ReturnType<typeof addAuthenticator>> | undefined;
  let confirmed = false;
  page.on('response', (r) => {
    if (r.url().endsWith('/api/auth/passkeys/confirm') && r.status() === 200) confirmed = true;
  });
  await page.route('**/api/auth/passkeys/options', async (route) => {
    expect(confirmed).toBe(true);
    await first.cdp.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId: first.authenticatorId });
    second = await addAuthenticator(page);
    await route.continue();
  });

  await expect(section.getByText('Zum Hinzufügen bestätigst du dich zuerst mit einem Passkey, der schon eingetragen ist.')).toBeVisible();
  await section.getByLabel('Name des Geräts').fill('Zweiter Schlüssel');
  await section.getByRole('button', { name: 'Passkey hinzufügen' }).click();
  await expect(section.getByRole('listitem')).toHaveCount(2);
  expect(confirmed).toBe(true);
  await page.unroute('**/api/auth/passkeys/options');
  await expect(section.getByText('Zweiter Schlüssel', { exact: true })).toBeVisible();
  expect(await second!.credentials()).toHaveLength(1);

  page.once('dialog', (d) => {
    expect(d.message()).toBe('Passkey „Zweiter Schlüssel“ entfernen? Mit diesem Gerät kannst du dich dann nicht mehr anmelden.');
    void d.accept();
  });
  await section.getByRole('button', { name: 'Entfernen: Zweiter Schlüssel' }).click();
  await expect(section.getByRole('listitem')).toHaveCount(1);
  await expect(section.getByText('Zweiter Schlüssel', { exact: true })).toHaveCount(0);
});

test('ohne Bestätigung mit einem vorhandenen Passkey gibt es keine Registrierungsoptionen', async ({ authed: page, server }) => {
  const res = await page.request.post(`${server.url}/api/auth/passkeys/options`, { headers: { origin: server.url } });
  expect(res.status()).toBe(403);
  expect(await res.json()).toEqual({ error: 'Bitte zuerst mit einem vorhandenen Passkey bestätigen', code: 'STEP_UP' });
});

test('Sitzungsliste markiert die eigene Sitzung', async ({ authed: page }) => {
  await openSettings(page);
  const section = page.locator('section', { has: page.getByRole('heading', { name: 'Sitzungen' }) });
  const mine = section.getByRole('listitem').filter({ hasText: '(diese Sitzung)' });
  await expect(mine).toHaveCount(1);
  await expect(mine.getByRole('button')).toHaveCount(0);
  await expect(section.getByText('Diese Sitzung beendest du mit „Abmelden“ oben in der Leiste.')).toBeVisible();
});

test('die eigene Sitzung über die API beenden', async ({ authed: page }) => {
  // Finding (Task 26): the UI offers no "Abmelden" for the current session, but the server accepts
  // `DELETE /api/auth/sessions/<eigene id>` – it ends the session like a logout (cookie cleared). This
  // test pins that behaviour; it does not reject the request.
  const result = await page.evaluate(async () => {
    const list = (await (await fetch('/api/auth/sessions')).json()) as { id: string; current: boolean }[];
    const current = list.find((s) => s.current)!;
    const del = await fetch(`/api/auth/sessions/${encodeURIComponent(current.id)}`, { method: 'DELETE' });
    const after = await fetch('/api/tree');
    return { del: del.status, after: after.status };
  });
  expect(result).toEqual({ del: 204, after: 401 });
});

test('Sprache über das Zahnrad umstellen: Seite lädt neu, Wahl bleibt, Ungetipptes geht nicht verloren', async ({ authed: page, server }) => {
  await expect(page.locator('html')).toHaveAttribute('lang', 'de'); // Playwright locale de-DE, preference auto
  await server.write('Bearbeiten/Sprache.md', '# Sprache\n\n');
  await openNote(page, 'Bearbeiten/Sprache.md');
  await page.locator('.note-view .cm-content').click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type('kurz vor dem Wechsel');

  // Right away (within the save debounce): the gear in the toolbar opens the settings.
  await page.getByRole('button', { name: 'Einstellungen', exact: true }).click();
  const region = page.getByRole('region', { name: 'Einstellungen' });
  const select = region.getByLabel('Sprache der Oberfläche');
  await expect(select).toHaveValue('auto');
  await expect(select.locator('option[value="auto"]')).toHaveText('Automatisch (Browsersprache: Deutsch)');
  await Promise.all([page.waitForEvent('load'), select.selectOption('en')]);

  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  expect(await server.read('Bearbeiten/Sprache.md')).toBe('# Sprache\n\nkurz vor dem Wechsel');
  expect(await page.evaluate(() => localStorage.getItem('vw-language'))).toBe('en');

  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const again = page.getByRole('region', { name: 'Settings' }).getByLabel('Interface language');
  await expect(again).toHaveValue('en');

  await Promise.all([page.waitForEvent('load'), again.selectOption('auto')]);
  await expect(page.locator('html')).toHaveAttribute('lang', 'de');
  expect(await page.evaluate(() => localStorage.getItem('vw-language'))).toBe('auto');

  // Phone width: the gear stays in the title bar.
  await page.setViewportSize({ width: 375, height: 700 });
  await expect(page.getByRole('button', { name: 'Einstellungen', exact: true })).toBeInViewport();
});

test('Sprachwechsel mit einer Notiz, die nicht gespeichert werden kann: keine Rückfrage, Entwurf kommt nach dem Neuladen zurück', async ({ authed: page, server }) => {
  // The language reload never asks "leave with unsaved changes?" (a cancelled reload would leave the
  // new language stored but not shown); unsaved text comes back as a draft. Opening the settings tab
  // already closes the note view, so the prompt itself is covered by the unit test of warnBeforeUnload.
  await server.write('Bearbeiten/Ohne Netz.md', '# Ohne Netz\n\n');
  await openNote(page, 'Bearbeiten/Ohne Netz.md');
  await page.route('**/api/note?*', (route) => (route.request().method() === 'PUT' ? route.abort('internetdisconnected') : route.fallback()));
  await page.locator('.note-view .cm-content').click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type('offline getippt');
  const dialogs: string[] = [];
  page.on('dialog', (d) => {
    dialogs.push(d.type());
    void d.dismiss(); // "Stay" for a beforeunload prompt
  });

  await page.getByRole('button', { name: 'Einstellungen', exact: true }).click();
  const select = page.getByRole('region', { name: 'Einstellungen' }).getByLabel('Sprache der Oberfläche');
  await Promise.all([page.waitForEvent('load'), select.selectOption('en')]);

  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  expect(dialogs).toEqual([]);
  expect(await page.evaluate(() => localStorage.getItem('vw-language'))).toBe('en');
  await page.getByRole('tab', { name: 'Ohne Netz' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Unsaved changes from your last visit were restored.' })).toBeVisible();
  await expect(page.locator('.note-view .cm-content')).toContainText('offline getippt');
  expect(await server.read('Bearbeiten/Ohne Netz.md')).toBe('# Ohne Netz\n\n');
});

test('Anmelde- bzw. Einrichtungsseite bietet die Sprachwahl an', async ({ page, server }) => {
  // No session and no authenticator: the login screen (or the setup screen when this test runs alone) stays.
  await page.goto(server.url);
  await expect(page.getByRole('heading', { name: /^(Anmelden|Passkey einrichten)$/ })).toBeVisible();
  const select = page.getByRole('combobox', { name: 'Sprache der Oberfläche' });
  await expect(select).toHaveValue('auto');
  await Promise.all([page.waitForEvent('load'), select.selectOption('fr')]);
  await expect(page.locator('html')).toHaveAttribute('lang', 'fr');
  await expect(page.getByRole('heading', { name: /^(Connexion|Configurer une clé d’accès)$/ })).toBeVisible();
  const french = page.getByRole('combobox', { name: 'Langue de l’interface' });
  await expect(french).toHaveValue('fr');
  await Promise.all([page.waitForEvent('load'), french.selectOption('auto')]);
  await expect(page.locator('html')).toHaveAttribute('lang', 'de');
  await expect(page.getByRole('combobox', { name: 'Sprache der Oberfläche' })).toHaveValue('auto');
});

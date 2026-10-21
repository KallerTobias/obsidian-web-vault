import type { Page } from '@playwright/test';
import { addAuthenticator, authenticatorOf, expect, test } from './fixtures';

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
  expect(await res.json()).toEqual({ error: 'Bitte zuerst mit einem vorhandenen Passkey bestätigen' });
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

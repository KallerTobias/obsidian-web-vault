import { addAuthenticator, expect, expectApp, test } from './fixtures';

test('Einrichtung mit Passkey, Abmelden, Anmelden; der Einrichtungslink gilt nur einmal', async ({ page, browser, server }) => {
  const authn = await addAuthenticator(page);

  await page.goto(server.setupLink);
  await expect(page.getByRole('heading', { name: 'Passkey einrichten' })).toBeVisible();
  // The token is removed from the address bar right away.
  await expect(page).toHaveURL(`${server.url}/setup`);
  await page.getByLabel('Name des Geräts').fill('Testbrowser');
  await page.getByRole('button', { name: 'Passkey anlegen' }).click();
  await expectApp(page);
  await expect(page).toHaveURL(`${server.url}/`);
  expect(await authn.credentials()).toHaveLength(1);

  const [cookie] = await page.context().cookies();
  expect(cookie).toMatchObject({ name: 'vw_session', httpOnly: true, secure: true, sameSite: 'Strict' });

  // Logging out ends the session; the passkey offered in the autofill (conditional UI) logs in again –
  // the virtual authenticator answers that request on its own.
  const sessionCookie = cookie!.value;
  await page.getByRole('button', { name: 'Abmelden' }).click();
  await expect
    .poll(async () => {
      const value = (await page.context().cookies())[0]?.value;
      return !!value && value !== sessionCookie;
    })
    .toBe(true);
  await expectApp(page);

  // The button flow, in a browser without conditional UI and with the same passkey.
  const [credential] = await authn.credentials();
  const second = await browser.newContext();
  try {
    const page2 = await second.newPage();
    await page2.addInitScript(() => {
      PublicKeyCredential.isConditionalMediationAvailable = async () => false;
    });
    await addAuthenticator(page2, credential);
    await page2.goto(server.url);
    await expect(page2.getByRole('heading', { name: 'Anmelden' })).toBeVisible();
    await page2.getByRole('button', { name: 'Mit Passkey anmelden' }).click();
    await expectApp(page2);
    await page2.getByRole('button', { name: 'Abmelden' }).click();
    await expect(page2.getByRole('heading', { name: 'Anmelden' })).toBeVisible();
    expect(await second.cookies()).toEqual([]);
  } finally {
    await second.close();
  }

  // A fresh browser with the same (used) setup link: refused before any passkey prompt.
  const other = await browser.newContext();
  try {
    const page2 = await other.newPage();
    await addAuthenticator(page2);
    await page2.goto(server.setupLink);
    await page2.getByRole('button', { name: 'Passkey anlegen' }).click();
    await expect(page2.getByRole('alert')).toHaveText(/Einrichtungslink ist ungültig, schon benutzt oder abgelaufen/);
    // Without a setup link the visitor gets the login, not the setup.
    await page2.goto(server.url);
    await expect(page2.getByRole('heading', { name: 'Anmelden' })).toBeVisible();
  } finally {
    await other.close();
  }
});

test('unter einer anderen Adresse als PUBLIC_URL: Hinweis mit Link statt Anmeldeknopf', async ({ page, server }) => {
  // Same server, reached via 127.0.0.1 while PUBLIC_URL is http://localhost:<port>.
  const other = server.url.replace('localhost', '127.0.0.1');
  await page.goto(`${other}/`);
  await expect(page.getByRole('heading', { name: 'Falsche Adresse' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Zur richtigen Adresse' })).toHaveAttribute('href', `${server.url}/`);
  await expect(page.getByRole('button', { name: 'Mit Passkey anmelden' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Passkey anlegen' })).toHaveCount(0);
});

import type { Page } from '@playwright/test';
import { expect, openNote, test } from './fixtures';

const tree = (page: Page) => page.getByRole('tree', { name: 'Dateien im Vault' });
const item = (page: Page, name: string) => tree(page).getByRole('treeitem', { name, exact: true });

/** Vault file names on disk may be NFD (macOS/Syncthing); find the one that is `name` in NFC. */
async function diskName(list: string[], name: string): Promise<string> {
  const found = list.find((n) => n.normalize('NFC') === name);
  if (!found) throw new Error(`${name} fehlt in ${list.join(', ')}`);
  return found;
}

test('Umbenennen passt die Links in anderen Notizen an', async ({ authed: page, server }) => {
  await item(page, 'Projekte').click();
  await item(page, 'Plan – 2026').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Umbenennen' }).click();

  const dialog = page.getByRole('dialog', { name: 'Umbenennen' });
  await expect(dialog.getByLabel('Neuer Name')).toHaveValue('Plan – 2026');
  const update = dialog.getByRole('checkbox', { name: '3 Notizen verlinken hierauf – Links anpassen?' });
  await expect(update).toBeChecked();
  await dialog.getByLabel('Neuer Name').fill('Plan 2027');
  await dialog.getByRole('button', { name: 'Umbenennen' }).click();
  await expect(dialog).toBeHidden();

  await expect(item(page, 'Plan 2027')).toBeVisible();
  await expect(item(page, 'Plan – 2026')).toHaveCount(0);
  expect(await server.list('Projekte')).toEqual(expect.arrayContaining(['Plan 2027.md']));
  expect(await server.list('Projekte')).not.toContain('Plan – 2026.md');
  expect(await server.read('00 Start.md')).toContain('[[Projekte/Plan 2027#Ziele|Plan, Abschnitt Ziele]]');
  expect(await server.read('Projekte/Notiz #1.md')).toContain('Verweist auf [[Plan 2027]]');
  // The NFD-named note is found and rewritten in place (no NFC duplicate appears).
  const root = await server.list();
  const overview = await diskName(root, 'Übersicht.md');
  expect(root.filter((n) => n.normalize('NFC') === 'Übersicht.md')).toHaveLength(1);
  expect(await server.read(overview)).toContain('Siehe auch [[Plan 2027]].');
});

test('Löschen verschiebt in den Papierkorb (.trash)', async ({ authed: page, server }) => {
  const folder = await diskName(await server.list(), 'Ärger & Co');
  const before = await server.read(`${folder}/Brief (Entwurf).md`);

  await item(page, 'Ärger & Co').click();
  page.once('dialog', (d) => {
    expect(d.message()).toContain('In den Papierkorb verschieben?');
    void d.accept();
  });
  await item(page, 'Brief (Entwurf)').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Löschen' }).click();

  await expect(item(page, 'Brief (Entwurf)')).toHaveCount(0);
  expect(await server.list(folder)).not.toContain('Brief (Entwurf).md');
  expect(await server.read('.trash/Brief (Entwurf).md')).toBe(before);
  // The trash itself is never shown.
  await expect(item(page, '.trash')).toHaveCount(0);
});

test('Bild einfügen lädt es in den Anhang-Ordner und verlinkt es', async ({ authed: page, server }) => {
  const png = (await server.readBytes('Bilder/Foto 1.png')).toString('base64');
  await openNote(page, 'Bearbeiten/Notizblock.md');
  await page.locator('.note-view .cm-content').click();
  await page.keyboard.press('ControlOrMeta+End');

  // A screenshot from the clipboard: an image file named `image.png`.
  await page.locator('.note-view .cm-content').evaluate((el, b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const data = new DataTransfer();
    data.items.add(new File([bytes], 'image.png', { type: 'image/png' }));
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  }, png);

  // `.obsidian/app.json` names `Bilder` as the attachment folder.
  await expect.poll(async () => (await server.list('Bilder')).filter((n) => n.startsWith('Pasted image '))).toHaveLength(1);
  const [name] = (await server.list('Bilder')).filter((n) => n.startsWith('Pasted image '));
  expect(name).toMatch(/^Pasted image \d{14}\.png$/);
  expect((await server.readBytes(`Bilder/${name}`)).toString('base64')).toBe(png);
  await expect.poll(() => server.read('Bearbeiten/Notizblock.md')).toBe(`# Notizblock\n\n![[${name}]]`);

  // Live preview shows the image (loaded, real size) once the cursor leaves its line.
  await page.keyboard.press('ControlOrMeta+Home');
  const img = page.locator('.note-view .cm-image-widget');
  await expect(img).toBeVisible();
  await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBe(480);
});

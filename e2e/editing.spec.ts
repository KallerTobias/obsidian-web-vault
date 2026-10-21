import type { Page } from '@playwright/test';
import { editorLines, expect, openNote, test } from './fixtures';

const editor = (page: Page) => page.locator('.note-view .cm-content');
const saveState = (page: Page) => page.locator('.save-state');

/** Puts the cursor at the end of the note. */
async function toEnd(page: Page): Promise<void> {
  await editor(page).click();
  await page.keyboard.press('ControlOrMeta+End');
}

test('Tippen wird nach kurzer Pause gespeichert', async ({ authed: page, server }) => {
  await server.write('Bearbeiten/Tippen.md', '# Tippen\n\n');
  await openNote(page, 'Bearbeiten/Tippen.md');
  await toEnd(page);
  await page.keyboard.type('Hallo Welt');
  await expect(saveState(page)).toHaveText('Ungespeichert');
  // Debounce 800 ms: on disk within about a second.
  await expect.poll(() => server.read('Bearbeiten/Tippen.md'), { timeout: 3000 }).toBe('# Tippen\n\nHallo Welt');
  await expect(saveState(page)).toHaveText('Gespeichert');
});

test('[[ schlägt Notizen vor und fügt den gewählten Link ein', async ({ authed: page, server }) => {
  await server.write('Bearbeiten/Verlinken.md', '# Verlinken\n\n');
  await openNote(page, 'Bearbeiten/Verlinken.md');
  await toEnd(page);
  await page.keyboard.press('Enter');
  await page.keyboard.type('Siehe [[Plan');
  const option = page.locator('.cm-tooltip-autocomplete [role="option"]', { hasText: 'Plan – 2026' }).first();
  await expect(option).toBeVisible();
  await option.click();
  await expect.poll(() => server.read('Bearbeiten/Verlinken.md')).toMatch(/\nSiehe \[\[Plan – 2026\]\]$/);
});

test('externe Änderung während des Bearbeitens: Konfliktdialog, „Beide behalten“ legt eine Kopie an', async ({ authed: page, server }) => {
  await openNote(page, 'Bearbeiten/Konflikt.md');
  // Hold the save until the file has changed on disk (deterministic instead of racing the debounce).
  let release!: () => void;
  const released = new Promise<void>((r) => (release = r));
  let held = false;
  await page.route('**/api/note?*', async (route) => {
    if (route.request().method() !== 'PUT') return route.fallback();
    held = true;
    await released;
    await route.fallback();
  });

  await toEnd(page);
  await page.keyboard.type('Meine Ergänzung.');
  await expect.poll(() => held).toBe(true);
  const disk = '# Konflikt\n\nVon außen geändert.\n';
  await server.write('Bearbeiten/Konflikt.md', disk);
  release();

  const dialog = page.getByRole('dialog', { name: 'Konflikt beim Speichern' });
  await expect(dialog).toBeVisible();
  await expect(saveState(page)).toHaveText('Konflikt');
  // Nothing was written over the external change.
  expect(await server.read('Bearbeiten/Konflikt.md')).toBe(disk);

  await dialog.getByRole('button', { name: 'Beide behalten' }).click();
  await expect(dialog).toBeHidden();
  await expect(editorLines(page).filter({ hasText: 'Von außen geändert.' })).toBeVisible();
  const copies = (await server.list('Bearbeiten')).filter((n) => /^Konflikt \(Konflikt \d{4}-\d{2}-\d{2} \d{4}\)\.md$/.test(n));
  expect(copies).toHaveLength(1);
  expect(await server.read(`Bearbeiten/${copies[0]}`)).toBe('# Konflikt\n\nAusgangstext.\nMeine Ergänzung.');
  expect(await server.read('Bearbeiten/Konflikt.md')).toBe(disk);
});

test('Entwurf nach Neuladen bei geänderter Platte führt zum Konfliktdialog statt zu stillem Überschreiben', async ({ authed: page, server }) => {
  await openNote(page, 'Bearbeiten/Entwurf.md');
  // Saves fail (as if offline) and no change events arrive: the text stays a draft in localStorage.
  const blockPut = (route: import('@playwright/test').Route) =>
    route.request().method() === 'PUT' ? route.abort('internetdisconnected') : route.fallback();
  await page.route('**/api/note?*', blockPut);
  await page.route('**/api/events*', (route) => route.abort('internetdisconnected'));

  await toEnd(page);
  await page.keyboard.type('Unterwegs geschrieben.');
  await expect(saveState(page)).toHaveText('Nicht gespeichert – Entwurf auf diesem Gerät gesichert');
  const disk = '# Entwurf\n\nAuf einem anderen Gerät geändert.\n';
  await server.write('Bearbeiten/Entwurf.md', disk);

  await page.unrouteAll();
  // The page warns about unsaved changes when it is left; confirm leaving.
  page.on('dialog', (d) => void (d.type() === 'beforeunload' ? d.accept() : d.dismiss()));
  await page.reload();

  const dialog = page.getByRole('dialog', { name: 'Konflikt beim Speichern' });
  await expect(dialog).toBeVisible();
  expect(await server.read('Bearbeiten/Entwurf.md')).toBe(disk);
  await dialog.getByRole('button', { name: 'Meine Fassung behalten' }).click();
  await expect(dialog).toBeHidden();
  await expect.poll(() => server.read('Bearbeiten/Entwurf.md')).toBe('# Entwurf\n\nAusgangstext.\nUnterwegs geschrieben.');
});

test('Live-Vorschau blendet Markierungen nur in der Zeile mit dem Cursor ein', async ({ authed: page }) => {
  await openNote(page, 'Bearbeiten/Formatierung.md');
  const line = editorLines(page).filter({ hasText: 'Hier steht' });
  await editorLines(page).filter({ hasText: 'Letzte Zeile.' }).click();
  await expect(line).toHaveText('Hier steht fett und kursiv.');

  await page.keyboard.press('ArrowUp');
  await expect(line).toHaveText('Hier steht **fett** und *kursiv*.');
  await page.keyboard.press('End');
  await page.keyboard.type(' Mehr **Text**');
  await expect(line).toHaveText('Hier steht **fett** und *kursiv*. Mehr **Text**');

  await page.keyboard.press('ArrowDown');
  await expect(line).toHaveText('Hier steht fett und kursiv. Mehr Text');
});

test('Frontmatter ist ausgeblendet, Alt-Pfeil-hoch in der ersten Zeile beschädigt es nicht', async ({ authed: page, server }) => {
  const path = 'Bearbeiten/Formatierung.md';
  const original = await server.read(path);
  await openNote(page, path);
  await expect(editorLines(page).filter({ hasText: 'status' })).toHaveCount(0);
  await expect(editorLines(page).first()).toHaveText('Erste Zeile im Text.');

  await editorLines(page).first().click();
  await page.keyboard.press('Home');
  await page.keyboard.press('Alt+ArrowUp');
  await page.keyboard.press('Alt+ArrowUp');
  await expect(editorLines(page).first()).toHaveText('Erste Zeile im Text.');
  await expect(saveState(page)).toHaveText('Gespeichert');

  // A real edit afterwards is saved with the frontmatter untouched.
  await page.keyboard.type('X');
  await expect.poll(() => server.read(path)).toBe(original.replace('Erste Zeile', 'XErste Zeile'));
});

test('Checkbox in der Live-Vorschau ändert genau ein Zeichen auf der Platte', async ({ authed: page, server }) => {
  const path = 'Bearbeiten/Aufgaben.md';
  const original = await server.read(path);
  await openNote(page, path);
  const boxes = page.locator('.note-view .cm-task-widget');
  await expect(boxes).toHaveCount(3);
  await expect(boxes.nth(0)).not.toBeChecked();

  await boxes.nth(0).click();
  await expect(boxes.nth(0)).toBeChecked();
  await expect.poll(() => server.read(path)).toBe(original.replace('- [ ] Milch', '- [x] Milch'));

  await boxes.nth(1).click();
  await expect.poll(() => server.read(path)).toBe(original.replace('- [ ] Milch', '- [x] Milch').replace('- [x] Brot', '- [ ] Brot'));
});

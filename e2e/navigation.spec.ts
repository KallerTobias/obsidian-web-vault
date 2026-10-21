import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { expect, openNote, test, type AppServer } from './fixtures';

const activeTab = (page: Page, name: string) =>
  page.getByRole('tablist', { name: 'Geöffnete Tabs' }).getByRole('tab', { name, exact: true, selected: true });

async function runCommand(page: Page, name: string): Promise<void> {
  await page.keyboard.press('ControlOrMeta+p');
  const palette = page.getByRole('dialog', { name: 'Befehlspalette' });
  await palette.getByRole('combobox').fill(name);
  await expect(palette.getByRole('option').first()).toHaveText(new RegExp(`^${name}`));
  await page.keyboard.press('Enter');
  await expect(palette).toBeHidden();
}

async function savedSettings(server: AppServer): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(server.dataDir, 'settings.json'), 'utf8').catch(() => '{}')) as Record<string, unknown>;
}

test('Suche (Strg+Umschalt+F) findet Text und öffnet die Notiz an der Zeile', async ({ authed: page }) => {
  await page.keyboard.press('ControlOrMeta+Shift+f');
  const input = page.getByRole('searchbox', { name: 'Suche im Vault' });
  await expect(input).toBeFocused();
  await input.fill('Willkommen');
  await expect(page.getByRole('tabpanel', { name: 'Suche' }).getByRole('status')).toHaveText('1 Notiz');
  await page.getByRole('button', { name: '00 Start, Zeile 3' }).click();
  await expect(activeTab(page, '00 Start')).toBeVisible();

  // Operators: a path prefix narrows the hits.
  await input.fill('path:Projekte Plan');
  await expect(page.getByRole('tabpanel', { name: 'Suche' }).getByRole('status')).toHaveText('2 Notizen');
});

test('Schnellsuche (Strg+O) öffnet per Name und Alias und legt neue Notizen an', async ({ authed: page, server }) => {
  const switcher = page.getByRole('dialog', { name: 'Schnellsuche' });

  await page.keyboard.press('ControlOrMeta+o');
  await switcher.getByRole('combobox').fill('Überblick');
  await expect(switcher.getByRole('option').first()).toContainText('Alias von Übersicht');
  await page.keyboard.press('Enter');
  await expect(activeTab(page, 'Übersicht')).toBeVisible();

  await page.keyboard.press('ControlOrMeta+o');
  await switcher.getByRole('combobox').fill('plan 2026');
  await expect(switcher.getByRole('option').first()).toContainText('Plan – 2026');
  await page.keyboard.press('Enter');
  await expect(activeTab(page, 'Plan – 2026')).toBeVisible();

  await page.keyboard.press('ControlOrMeta+o');
  await switcher.getByRole('combobox').fill('Neue Idee');
  await expect(switcher.getByRole('option').last()).toHaveText('Notiz ‚Neue Idee‘ anlegen');
  await switcher.getByRole('option').last().click();
  await expect(activeTab(page, 'Neue Idee')).toBeVisible();
  await expect.poll(() => server.read('Neue Idee.md')).toBe('');
});

test('Befehlspalette (Strg+P) führt Befehle aus und schließt mit Esc', async ({ authed: page }) => {
  await openNote(page, '00 Start.md');
  await runCommand(page, 'Lesen');
  await expect(page.getByRole('group', { name: 'Ansicht' }).getByRole('button', { name: 'Lesen' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.reading-view h1')).toHaveText('Start');

  await page.keyboard.press('ControlOrMeta+p');
  const palette = page.getByRole('dialog', { name: 'Befehlspalette' });
  await expect(palette).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(palette).toBeHidden();
});

test('Neue Notiz aus Vorlage und tägliche Notiz', async ({ authed: page, server }) => {
  // Daily notes are off by default: the app says so and leads to the settings.
  await runCommand(page, 'Tägliche Notiz öffnen');
  const notice = page.getByRole('status').filter({ hasText: 'Tägliche Notizen sind ausgeschaltet' });
  await expect(notice).toBeVisible();
  await notice.getByRole('button', { name: 'Zu den Einstellungen' }).click();
  await expect(activeTab(page, 'Einstellungen')).toBeVisible();

  await page.getByLabel('Vorlagenordner').fill('Vorlagen');
  await page.getByLabel('Tägliche Notizen verwenden').check();
  await page.getByLabel('Ordner', { exact: true }).fill('Tagebuch');
  await page.getByLabel('Vorlage', { exact: true }).fill('Vorlagen/Tagesnotiz.md');
  await page.getByLabel('Vorlage', { exact: true }).blur();
  await expect
    .poll(() => savedSettings(server))
    .toMatchObject({ templatesFolder: 'Vorlagen', dailyNotes: { enabled: true, folder: 'Tagebuch', template: 'Vorlagen/Tagesnotiz.md' } });

  // Template: pick it, give a title, the placeholders are filled in.
  await runCommand(page, 'Neue Notiz aus Vorlage');
  const picker = page.getByRole('dialog', { name: 'Neue Notiz aus Vorlage' });
  await picker.getByRole('option', { name: 'Tagesnotiz' }).click();
  const titleDialog = page.getByRole('dialog', { name: 'Neue Notiz aus „Tagesnotiz“' });
  await titleDialog.getByLabel('Titel').fill('Projektidee');
  await titleDialog.getByRole('button', { name: 'Anlegen' }).click();
  await expect(activeTab(page, 'Projektidee')).toBeVisible();
  expect(await server.read('Projektidee.md')).toMatch(/^# Projektidee\n\nErstellt am [^,]+, \d{1,2}\. \S+ \d{4} um \d{2}:\d{2}\.\n?$/);

  // Daily note: created from its template on first use, opened (not duplicated) afterwards.
  const today = await page.evaluate(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  });
  await runCommand(page, 'Tägliche Notiz öffnen');
  await expect(activeTab(page, today)).toBeVisible();
  const first = await server.read(`Tagebuch/${today}.md`);
  expect(first).toMatch(new RegExp(`^# ${today}\\n\\nErstellt am `));

  await openNote(page, '00 Start.md');
  await runCommand(page, 'Tägliche Notiz öffnen');
  await expect(activeTab(page, today)).toBeVisible();
  expect(await server.list('Tagebuch')).toEqual([`${today}.md`]);
  expect(await server.read(`Tagebuch/${today}.md`)).toBe(first);
});

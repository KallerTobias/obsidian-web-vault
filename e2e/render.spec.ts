import type { Locator, Page } from '@playwright/test';
import { expect, openNote, test } from './fixtures';

const reading = (page: Page) => page.locator('.note-view .reading-view');
const live = (page: Page) => page.locator('.note-view .cm-content');

async function setMode(page: Page, mode: 'Lesen' | 'Bearbeiten'): Promise<void> {
  await page.getByRole('group', { name: 'Ansicht' }).getByRole('button', { name: mode, exact: true }).click();
}

/** The image really loaded (not a broken-image icon) with the fixture's size. */
async function expectLoadedImage(img: Locator): Promise<void> {
  await expect(img).toBeVisible();
  await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth)).toBe(480);
  const box = await img.boundingBox();
  expect(box!.width).toBeGreaterThan(200);
}

function pdfFrames(page: Page): { pdf: boolean; viewer: boolean; error: boolean } {
  const urls = page.frames().map((f) => f.url());
  return {
    pdf: urls.some((u) => u.includes('/api/file?path=Bilder%2FHandbuch.pdf')),
    viewer: urls.some((u) => u.startsWith('chrome-extension://')),
    error: urls.some((u) => u.startsWith('chrome-error:')),
  };
}

// The `problems` fixture fails every test that triggers a CSP violation or an uncaught error.

test('Mermaid und KaTeX unter der Produktions-CSP: Lesen und Live-Vorschau', async ({ authed: page }) => {
  await openNote(page, 'Darstellung/Diagramme.md');

  // Live preview (default mode): the diagram and the display formula are widgets.
  await expect(live(page).locator('.cm-mermaid-widget .mermaid svg')).toBeVisible();
  await expect(live(page).locator('.cm-mermaid-widget svg')).toContainText('Start');
  await expect(live(page).locator('.cm-math-widget .katex-display')).toBeVisible();

  await setMode(page, 'Lesen');
  await expect(reading(page).locator('.mermaid svg')).toBeVisible();
  await expect(reading(page).locator('.mermaid svg')).toContainText('Ziel');
  await expect(reading(page).locator('.katex-display .katex')).toBeVisible();
  // Inline math in the text as well.
  await expect(reading(page).locator('p .katex')).toBeVisible();
  // KaTeX fonts come from our own origin.
  await expect.poll(() => page.evaluate(() => document.fonts.check('16px KaTeX_Main'))).toBe(true);
});

test('Bild- und PDF-Einbettung in Lesen und Live-Vorschau', async ({ authed: page }) => {
  const pdfResponse = page.waitForResponse((r) => r.url().includes('/api/file?path=Bilder%2FHandbuch.pdf'));
  await openNote(page, 'Darstellung/Einbettungen.md');

  await expectLoadedImage(live(page).locator('.cm-image-widget'));
  const liveFrame = live(page).locator('.cm-embed-widget iframe');
  await expect(liveFrame).toBeVisible();
  const res = await pdfResponse;
  expect(res.status()).toBe(200);
  expect(res.headers()['content-type']).toBe('application/pdf');
  expect(res.headers()['content-security-policy']).toBe("frame-ancestors 'self'");
  // Framing was allowed: the frame holds the PDF and Chromium's PDF viewer, not its error page.
  await expect.poll(() => pdfFrames(page)).toEqual({ pdf: true, viewer: true, error: false });

  await setMode(page, 'Lesen');
  await expectLoadedImage(reading(page).locator('img[alt="Foto 1.png"], .embed img').first());
  await expect(reading(page).locator('.embed-pdf iframe')).toBeVisible();
  await expect(reading(page).locator('.embed-pdf iframe')).toHaveAttribute('src', `/api/file?path=${encodeURIComponent('Bilder/Handbuch.pdf')}`);
  await expect.poll(() => pdfFrames(page)).toEqual({ pdf: true, viewer: true, error: false });
});

test('Callout und Tabelle in Lesen und Live-Vorschau', async ({ authed: page }) => {
  await openNote(page, 'Darstellung/Elemente.md');
  await expect(live(page).locator('.cm-callout-widget .callout')).toContainText('Hinweis');
  await expect(live(page).locator('.cm-table-widget table td', { hasText: 'Äpfel' })).toBeVisible();

  await setMode(page, 'Lesen');
  const callout = reading(page).locator('.callout');
  await expect(callout).toBeVisible();
  await expect(callout).toContainText('Ein Callout mit Inhalt.');
  await expect(callout.locator('strong')).toHaveText('Inhalt');
  await expect(reading(page).getByRole('table').getByRole('cell', { name: 'Birnen' })).toBeVisible();
});

test('Links mit Umlauten, NFD-Dateinamen, Leerzeichen und Raute öffnen die richtige Notiz', async ({ authed: page }) => {
  const tab = (name: string) => page.getByRole('tablist', { name: 'Geöffnete Tabs' }).getByRole('tab', { name, exact: true, selected: true });
  await openNote(page, '00 Start.md');
  await setMode(page, 'Lesen');
  await expectLoadedImage(reading(page).locator('img').first());

  // Markdown link with an encoded `#` (`Notiz%20%231.md`).
  await reading(page).getByRole('link', { name: 'Notiz mit Raute' }).click();
  await expect(tab('Notiz #1')).toBeVisible();
  await page.getByRole('button', { name: 'Zurück', exact: true }).click();
  await expect(tab('00 Start')).toBeVisible();

  // Wiki link in NFC to a file whose name is NFD on disk.
  await setMode(page, 'Lesen');
  await reading(page).getByRole('link', { name: 'Übersicht' }).click();
  await expect(tab('Übersicht')).toBeVisible();
  await page.getByRole('button', { name: 'Zurück', exact: true }).click();

  await setMode(page, 'Lesen');
  await reading(page).getByRole('link', { name: 'Brief (Entwurf)' }).click();
  await expect(tab('Brief (Entwurf)')).toBeVisible();
  // Its image embed resolves by name from another folder.
  await setMode(page, 'Lesen');
  await expectLoadedImage(reading(page).locator('img').first());
});

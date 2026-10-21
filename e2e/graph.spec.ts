import type { Page } from '@playwright/test';
import { expect, expectApp, test } from './fixtures';

/** Opens the graph tab with the sidebar's Graph button. */
async function openGraph(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Graph öffnen' }).click();
  await expect(page.getByRole('tab', { name: 'Graph', selected: true })).toBeVisible();
}

/** The command palette's way. */
async function openGraphViaPalette(page: Page): Promise<void> {
  await page.keyboard.press('ControlOrMeta+p');
  const palette = page.getByRole('dialog', { name: 'Befehlspalette' });
  await palette.getByRole('combobox').fill('Graph');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('tab', { name: 'Graph', selected: true })).toBeVisible();
}

const surface = (page: Page) => page.locator('.graph-view .surface');
const modeButton = (page: Page, mode: '2D' | '3D') => page.getByRole('group', { name: 'Darstellung' }).getByRole('button', { name: mode });

/** Centre (CSS px, page coordinates) of a node drawn in `color` on the 2D canvas, or null. */
function findNode(page: Page, color: string): Promise<{ x: number; y: number } | null> {
  return surface(page)
    .locator('canvas')
    .first()
    .evaluate((canvas: HTMLCanvasElement, hex) => {
      const want = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
      const ctx = canvas.getContext('2d')!;
      const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);
      let sx = 0;
      let sy = 0;
      let n = 0;
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const i = (y * width + x) * 4;
          if (data[i] === want[0] && data[i + 1] === want[1] && data[i + 2] === want[2] && data[i + 3] === 255) {
            sx += x;
            sy += y;
            n++;
          }
        }
      }
      if (n < 4) return null;
      const r = canvas.getBoundingClientRect();
      return { x: r.left + (sx / n) * (r.width / canvas.width), y: r.top + (sy / n) * (r.height / canvas.height) };
    }, color);
}

test('Graph: 2D zeichnet, 3D lädt ohne CSP-Verstoß, Klick auf einen Knoten öffnet die Notiz', async ({ authed: page }) => {
  // Records every use of the `Function` constructor (blocked by the CSP anyway, but reported here by name).
  await page.addInitScript(() => {
    const calls: string[] = [];
    (window as unknown as { __functionCalls: string[] }).__functionCalls = calls;
    const record = (args: unknown[]) => void calls.push(String(args[args.length - 1]).slice(0, 80));
    globalThis.Function = new Proxy(Function, {
      construct: (target, args) => (record(args), Reflect.construct(target, args)),
      apply: (target, self, args) => (record(args), Reflect.apply(target, self, args)),
    });
  });
  await page.reload();
  await expectApp(page);
  const functionCalls = () => page.evaluate(() => (window as unknown as { __functionCalls: string[] }).__functionCalls);

  // Positive control: the spy sees a `Function` call (so "never called" below is not vacuous).
  // (Playwright's evaluate is exempt from the CSP, so this raises no violation.)
  await page.evaluate(() => {
    try {
      new Function('');
    } catch {
      /* blocked by the CSP */
    }
  });
  expect(await functionCalls()).toEqual(['']);
  await page.evaluate(() => ((window as unknown as { __functionCalls: string[] }).__functionCalls.length = 0));
  expect(await functionCalls()).toEqual([]);

  await openGraph(page);
  await expect(modeButton(page, '2D')).toHaveAttribute('aria-pressed', 'true');
  await expect(surface(page).locator('canvas').first()).toBeVisible();
  // The vault's notes are drawn (some pixels in the node colour).
  await expect.poll(async () => (await findNode(page, '#8a8a8a')) !== null).toBe(true);

  // 3D: its own chunk (three.js, ngraph). Its unused `new Function` code would show up as a CSP
  // violation (`problems` fixture) – it must never run.
  const chunk = page.waitForResponse((r) => /\/assets\/3d-force-graph-[\w-]+\.js$/.test(r.url()));
  await modeButton(page, '3D').click();
  expect((await chunk).status()).toBe(200);
  const gl = surface(page).locator('canvas');
  await expect(gl).toBeVisible();
  await expect.poll(() => gl.evaluate((c: HTMLCanvasElement) => !!(c.getContext('webgl2') ?? c.getContext('webgl')))).toBe(true);
  await expect(page.getByText('Diese Ansicht kann hier nicht dargestellt werden')).toHaveCount(0);
  expect(await functionCalls()).toEqual([]);

  await modeButton(page, '2D').click();
  await expect(modeButton(page, '2D')).toHaveAttribute('aria-pressed', 'true');

  // One node left (filter), drawn near the centre; click it.
  await page.getByLabel('Filter', { exact: true }).fill('file:Aufgaben');
  await expect(async () => {
    const node = await findNode(page, '#8a8a8a');
    expect(node).not.toBeNull();
    await page.mouse.click(node!.x, node!.y);
    await expect(page.getByRole('tab', { name: 'Aufgaben', selected: true })).toBeVisible({ timeout: 1000 });
  }).toPass();
  await expect(page.locator('.note-view .cm-content')).toContainText('Milch kaufen');
});

test('Graph: die Befehlspalette öffnet denselben Tab, der Button fokussiert ihn nur', async ({ authed: page }) => {
  await openGraphViaPalette(page);
  await page.getByRole('button', { name: 'Graph öffnen' }).click();
  await expect(page.getByRole('tab', { name: 'Graph' })).toHaveCount(1);
});

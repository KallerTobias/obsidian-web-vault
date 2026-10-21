/// <reference lib="dom" />
import { describe, expect, it } from 'vitest';
import { createFileLookup } from '@shared/resolve';
import { renderMarkdown } from '../../web/src/lib/markdown/render';

const lookup = createFileLookup([
  'Start.md',
  'Notiz.md',
  'Ordner/Notiz A.md',
  'Ordner/Tief.md',
  'Anhänge/bild.jpg',
  'Anhänge/doc.pdf',
  'Anhänge/ton.mp3',
]);
const ctx = { path: 'Start.md', lookup };

/** Renders and parses into a detached element for DOM queries. */
function dom(md: string, depth?: number): HTMLElement {
  const el = document.createElement('div');
  el.innerHTML = renderMarkdown(md, { ...ctx, depth });
  return el;
}
const q = (el: HTMLElement, sel: string) => el.querySelector<HTMLElement>(sel);
const qa = (el: HTMLElement, sel: string) => [...el.querySelectorAll<HTMLElement>(sel)];

describe('renderMarkdown – CommonMark + GFM', () => {
  it('renders tables', () => {
    const el = dom('| a | b |\n|---|---|\n| 1 | 2 |');
    expect(qa(el, 'table th').map((t) => t.textContent)).toEqual(['a', 'b']);
    expect(qa(el, 'table td').map((t) => t.textContent)).toEqual(['1', '2']);
  });

  it('renders task checkboxes with their 0-based source line, clickable', () => {
    const el = dom('---\ntags: [x]\n---\n\n- [ ] eins\n- [x] zwei\n\n1. [ ] drei');
    const boxes = qa(el, 'input[type="checkbox"]') as HTMLInputElement[];
    expect(boxes.map((b) => b.dataset.line)).toEqual(['4', '5', '7']);
    expect(boxes.map((b) => b.checked)).toEqual([false, true, false]);
    expect(boxes.every((b) => !b.disabled)).toBe(true);
  });

  it('keeps checkbox line numbers after a multi-line comment', () => {
    const el = dom('%%\nalt\n%%\n- [ ] a');
    expect(q(el, 'input')!.dataset.line).toBe('3');
  });

  it('disables checkboxes inside embeds (depth > 0)', () => {
    const el = dom('- [ ] a', 1);
    const box = q(el, 'input') as HTMLInputElement;
    expect(box.disabled).toBe(true);
    expect(box.hasAttribute('data-line')).toBe(false);
  });

  it('renders strikethrough', () => {
    expect(q(dom('~~weg~~'), 'del')!.textContent).toBe('weg');
  });

  it('autolinks URLs as external links', () => {
    const el = dom('Siehe https://example.com und www.example.org.');
    const links = qa(el, 'a');
    expect(links.map((a) => a.getAttribute('href'))).toEqual(['https://example.com', 'http://www.example.org']);
    for (const a of links) {
      expect(a.getAttribute('rel')).toBe('noopener noreferrer nofollow');
      expect(a.getAttribute('target')).toBe('_blank');
    }
  });

  it('renders code blocks with a language class', () => {
    const code = q(dom('```js\nlet a = 1;\n```'), 'pre > code')!;
    expect(code.className).toBe('language-js');
    expect(code.textContent).toBe('let a = 1;\n');
  });

  it('gives headings ids for subpath navigation', () => {
    const el = dom('## Überschrift Eins\n\n## Überschrift Eins');
    expect(qa(el, 'h2').map((h) => h.id)).toEqual(['user-content-überschrift-eins', 'user-content-überschrift-eins-1']);
  });

  it('renders footnotes', () => {
    const el = dom('Text[^1]\n\n[^1]: Fuß');
    const ref = q(el, 'sup a')!;
    const target = ref.getAttribute('href')!.slice(1);
    expect(target).toBe('user-content-fn-1');
    expect(el.querySelector(`[id="${target}"]`)!.textContent).toContain('Fuß');
  });

  it('omits the frontmatter', () => {
    const el = dom('﻿---\ntitel: geheim\n---\n# Kopf');
    expect(el.textContent).not.toContain('geheim');
    expect(q(el, 'h1')!.textContent).toBe('Kopf');
  });
});

describe('renderMarkdown – Obsidian syntax', () => {
  it('renders wikilinks with path, alias, heading and block subpaths', () => {
    const el = dom('[[Notiz]] [[Ordner/Notiz A|Alias]] [[Notiz#Überschrift]] [[notiz A#^block1]] [[#Lokal]]');
    const links = qa(el, 'a.internal-link');
    expect(links.map((a) => a.dataset.href)).toEqual(['Notiz.md', 'Ordner/Notiz A.md', 'Notiz.md', 'Ordner/Notiz A.md', 'Start.md']);
    expect(links.map((a) => a.dataset.subpath ?? null)).toEqual([null, null, 'Überschrift', '^block1', 'Lokal']);
    expect(links.map((a) => a.textContent)).toEqual(['Notiz', 'Alias', 'Notiz > Überschrift', 'notiz A > ^block1', 'Lokal']);
    expect(links.some((a) => a.classList.contains('is-unresolved'))).toBe(false);
  });

  it('marks unresolved wikilinks', () => {
    const a = q(dom('[[Fehlt noch]]'), 'a.internal-link')!;
    expect(a.classList.contains('is-unresolved')).toBe(true);
    expect(a.dataset.href).toBe('Fehlt noch');
  });

  it('treats markdown links to vault files as internal links', () => {
    const el = dom('[A](Ordner/Notiz%20A.md) [B](<Ordner/Notiz A.md#Kopf>) [C](neu.md)');
    const links = qa(el, 'a.internal-link');
    expect(links.map((a) => a.dataset.href)).toEqual(['Ordner/Notiz A.md', 'Ordner/Notiz A.md', 'neu.md']);
    expect(links[1]!.dataset.subpath).toBe('Kopf');
    expect(links[2]!.classList.contains('is-unresolved')).toBe(true);
  });

  it('points unresolved Markdown links relative to the note folder (for creating them)', () => {
    const el = document.createElement('div');
    el.innerHTML = renderMarkdown('[a](neu.md) [b](../oben.md) [c](/wurzel.md) [d](../../raus.md) [[Wiki neu]]', { path: 'Ordner/Tief.md', lookup });
    expect(qa(el, 'a.internal-link').map((a) => a.dataset.href)).toEqual(['Ordner/neu.md', 'oben.md', 'wurzel.md', 'raus.md', 'Wiki neu']);
  });

  it('renders note embeds as placeholders for the reading view', () => {
    const el = dom('![[Notiz]]\n\n![[Ordner/Notiz A#Kopf]]');
    const embeds = qa(el, '.embed');
    expect(embeds.map((e) => e.tagName)).toEqual(['DIV', 'DIV']);
    expect(embeds.map((e) => e.dataset.embed)).toEqual(['Notiz.md', 'Ordner/Notiz A.md']);
    expect(embeds.map((e) => e.dataset.subpath ?? null)).toEqual([null, 'Kopf']);
  });

  it('renders image embeds from the vault with width', () => {
    const img = q(dom('![[bild.jpg|300]]'), 'img')!;
    expect(img.getAttribute('src')).toBe('/api/file?path=Anh%C3%A4nge%2Fbild.jpg');
    expect(img.getAttribute('width')).toBe('300');
    const img2 = q(dom('![[bild.jpg|300x200]]'), 'img')!;
    expect([img2.getAttribute('width'), img2.getAttribute('height')]).toEqual(['300', '200']);
  });

  it('renders markdown images from the vault and external images without referrer', () => {
    const el = dom('![a](Anhänge/bild.jpg) ![b](https://example.com/x.png) ![c](fehlt.png)');
    const imgs = qa(el, 'img');
    expect(imgs.map((i) => i.getAttribute('src'))).toEqual(['/api/file?path=Anh%C3%A4nge%2Fbild.jpg', 'https://example.com/x.png']);
    expect(imgs[1]!.getAttribute('referrerpolicy')).toBe('no-referrer');
    expect(imgs[1]!.getAttribute('loading')).toBe('lazy');
  });

  it('renders PDF and audio embeds as placeholders', () => {
    const el = dom('![[doc.pdf#page=3]]\n\n![[ton.mp3]]');
    const embeds = qa(el, '.embed');
    expect(embeds.map((e) => e.dataset.embed)).toEqual(['Anhänge/doc.pdf', 'Anhänge/ton.mp3']);
    expect(embeds[0]!.dataset.subpath).toBe('page=3');
  });

  it('renders unresolved embeds as unresolved links', () => {
    const a = q(dom('![[Gibt es nicht]]'), 'a.internal-link.is-unresolved')!;
    expect(a.dataset.href).toBe('Gibt es nicht');
  });

  it('renders callouts, including folded ones', () => {
    const el = dom('> [!faq]- Häufige **Frage**\n> Antwort\n> mehr');
    const c = q(el, 'div.callout')!;
    expect(c.dataset.callout).toBe('faq');
    expect(c.dataset.fold).toBe('-');
    expect(q(c, '.callout-title')!.textContent).toBe('Häufige Frage');
    expect(q(c, '.callout-title strong')).not.toBeNull();
    expect(q(c, '.callout-content')!.textContent!.trim()).toBe('Antwort\nmehr');
    const plain = q(dom('> [!INFO]\n> x'), 'div.callout')!;
    expect(plain.dataset.callout).toBe('info');
    expect(plain.dataset.fold).toBe('');
    expect(q(plain, '.callout-title')!.textContent).toBe('Info');
  });

  it('renders ==highlights== as <mark>, also around formatting', () => {
    const el = dom('Das ist ==wichtig== und ==sehr **fett**==.');
    expect(qa(el, 'mark').map((m) => m.textContent)).toEqual(['wichtig', 'sehr fett']);
    expect(q(el, 'mark strong')!.textContent).toBe('fett');
  });

  it('removes %%comments%% but not inside code', () => {
    const el = dom('a %%geheim%% b\n\n%%\nblock\n%%\n\n`%%code%%`');
    expect(el.textContent).not.toContain('geheim');
    expect(el.textContent).not.toContain('block');
    expect(q(el, 'code')!.textContent).toBe('%%code%%');
  });

  it('renders inline and display math with KaTeX', () => {
    const el = dom('Inline $x^2$ und\n\n$$\n\\frac{a}{b}\n$$\n\nund $$y$$');
    expect(qa(el, '.katex').length).toBe(3);
    expect(qa(el, '.katex-display').length).toBe(2);
  });

  it('keeps mermaid source for client-side rendering', () => {
    const pre = q(dom('```mermaid\ngraph TD\nA-->B\n```'), 'pre.mermaid-src')!;
    expect(pre.textContent).toBe('graph TD\nA-->B\n');
    expect(q(pre, 'code')).toBeNull();
  });

  it('renders nested tags', () => {
    const el = dom('Ein #a/b Tag, #123 nicht, `#code` nicht, x#y nicht.');
    const tags = qa(el, 'a.tag');
    expect(tags.map((t) => t.dataset.tag)).toEqual(['a/b']);
    expect(tags[0]!.textContent).toBe('#a/b');
  });

  it('turns block ids into anchors and hides the marker', () => {
    const el = dom('Absatz mit Kennung ^abc-1\n\n- Punkt ^li\n\n| a |\n|---|\n| b |\n\n^tab');
    expect(q(el, 'p')!.id).toBe('user-content-^abc-1');
    expect(el.textContent).not.toContain('^abc-1');
    expect(q(el, 'li')!.id).toBe('user-content-^li');
    expect(q(el, 'table')!.id).toBe('user-content-^tab');
    expect(el.textContent).not.toContain('^tab');
  });
});

describe('renderMarkdown – sanitising untrusted notes', () => {
  it('removes scripts, event handlers and javascript: URLs', () => {
    const html = renderMarkdown(
      [
        '<script>alert(1)</script>',
        '<img src="x" onerror="alert(2)">',
        '[klick](javascript:alert(3))',
        '<a href="javascript:alert(4)">a</a>',
        '<a href="JaVaScRiPt:alert(5)">b</a>',
        '[[x]] <svg onload="alert(6)"></svg>',
        '<iframe src="https://evil.example"></iframe>',
        '<form action="/api/entry"><button>x</button></form>',
        '<div style="position:fixed">s</div>',
        '<style>body{display:none}</style>',
        '<object data="x"></object><embed src="x">',
        '![x](javascript:alert(7))',
        '<a href="data:text/html,<script>alert(8)</script>">d</a>',
      ].join('\n\n'),
      ctx,
    );
    expect(html).not.toMatch(/<script|onerror|onload|javascript:|<iframe|<form|<svg|<style|<object|<embed|data:text|style=/i);
    expect(html).not.toContain('alert(1)');
    expect(html).not.toContain('display:none');
  });

  it('keeps the safe inline HTML subset', () => {
    const el = dom('<b>f</b> <i>k</i> <kbd>Strg</kbd> x<sup>2</sup> H<sub>2</sub>O <mark>m</mark> <span>s</span><br>\n\n<details><summary>Mehr</summary>\n\nInhalt\n\n</details>');
    for (const sel of ['b', 'i', 'kbd', 'sup', 'sub', 'mark', 'span', 'br', 'details > summary']) expect(q(el, sel), sel).not.toBeNull();
  });

  it('only allows http(s)/mailto and in-page hrefs on Markdown links', () => {
    const el = dom('[m](mailto:a@b.de) [f](ftp://x.example/a) [h](https://example.com)');
    expect(qa(el, 'a').map((a) => a.getAttribute('href'))).toEqual(['mailto:a@b.de', 'https://example.com']);
  });

  it('reduces raw HTML to the inline subset without attributes', () => {
    const el = dom(
      [
        '<a href="mailto:a@b.de">roh-a</a>',
        '<a class="internal-link" data-href="Geheim.md" href="#">fake</a> <a class="tag" data-tag="x">t</a>',
        '<img src="/api/file?path=Geheim.png"> <img src="https://example.com/x.png">',
        '<input type="checkbox" data-line="0">',
        '<div class="embed" data-embed="Geheim.md">e</div><span class="embed" data-embed="Geheim.md">s</span>',
        '<h1 id="x">Kopf</h1>',
        '<table><tr><td>zelle</td></tr></table>',
        '<div class="callout" data-callout="info" id="c" title="t" style="color:red"><b class="x" data-foo="1">fett</b></div>',
        '<details open><summary class="s">Mehr</summary>Inhalt</details>',
      ].join('\n\n'),
    );
    expect(qa(el, 'a, img, input, h1, table, td, .embed, .callout, [data-href], [data-embed], [data-line]')).toEqual([]);
    for (const node of qa(el, 'b, div, span, details, summary')) {
      expect(node.getAttributeNames().filter((n) => n !== 'open'), node.tagName).toEqual([]);
    }
    // Text content survives.
    for (const t of ['roh-a', 'fake', 'Kopf', 'zelle', 'fett', 'Mehr']) expect(el.textContent).toContain(t);
    expect(q(el, 'details > summary')).not.toBeNull();
  });

  it('keeps Markdown inside raw HTML blocks rendered normally', () => {
    const el = dom('<details>\n<summary>Mehr</summary>\n\n- [ ] Aufgabe [[Notiz]]\n\n</details>');
    expect(q(el, 'details a.internal-link')!.dataset.href).toBe('Notiz.md');
    expect(q(el, 'details input[type="checkbox"]')!.dataset.line).toBe('3');
  });

  it('cannot break out of attributes with crafted link targets', () => {
    const el = dom('[[a" onclick="alert(1)]] ![[b" onerror="x.png]] #t"x [x](<a" onclick="y.md>)');
    for (const node of qa(el, '*')) {
      expect(node.getAttributeNames().filter((n) => n.startsWith('on'))).toEqual([]);
    }
    expect(qa(el, 'a.internal-link').map((a) => a.dataset.href)).toEqual(['a" onclick="alert(1)', 'b" onerror="x.png', 'a" onclick="y.md']);
  });
});

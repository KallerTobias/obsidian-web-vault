# XSS Security Report

## Status: PASS (Info notes only)

Note content is untrusted (synced from other devices and AI agents), so this category was read closely.

## Findings

Raw-HTML sinks in the frontend (complete list from `grep -rn "{@html|innerHTML|outerHTML|insertAdjacentHTML|document.write|srcdoc|new Function|eval("`):

| Sink | Source | Assessment |
|---|---|---|
| `web/src/components/ReadingView.svelte:160` `{@html html}` | `renderMarkdown()` | sanitized |
| `web/src/lib/markdown/embeds.ts:177` `body.innerHTML` | `renderMarkdown()` | sanitized |
| `web/src/lib/editor/block-widgets.ts:369` `root.innerHTML` | `renderCached()` → `renderMarkdown()` | sanitized |
| `web/src/lib/markdown/mermaid.ts:32` `figure.innerHTML = svg` | Mermaid `render()` with `securityLevel: 'strict'` | relies on Mermaid's built-in DOMPurify + CSP |

`renderMarkdown` pipeline (`web/src/lib/markdown/render.ts`):
- `rehype-sanitize` with GitHub's schema, minimal additions (classes/data-attrs the app's own plugin produces), `strip` for script/style/iframe/object/svg/math/…, `href` protocols `http/https/mailto`, `src` `http/https` (`:39-56`).
- Raw HTML from the note is restricted *before* sanitizing to an attribute-free inline subset (`b i br sup sub kbd details summary span div mark`), dangerous elements dropped with content, everything else unwrapped (`:78-125`). Elements built from Markdown are distinguished from raw ones by a per-session random mark (`:87-95`), so notes cannot forge app controls (internal links, embeds, checkboxes).
- After sanitizing: relative/other hrefs removed, external links get `noopener noreferrer nofollow` + `_blank`, in-page anchors and ids prefixed `user-content-` (DOM clobbering), images only from `/api/file?path=` or http(s) (`:204-243`).
- KaTeX runs after sanitizing on text only, `trust: false`, `maxExpand`/`maxSize` limits (`:170-184`); installed KaTeX is 0.19.0 (not affected by GHSA-238p-pmpm-9mq7).
- Link clicks: `window.open` only after `safeExternalHref` (`web/src/lib/editor/inline-hide.ts:73`, `live-preview.ts:74-76`, `block-widgets.ts:676-677`); internal links via `data-href` handled by the app router.
- Graph: 2D labels drawn on canvas, 3D labels as `textContent` nodes — the library's HTML tooltip is deliberately bypassed (`web/src/lib/graph/GraphCanvas.svelte:261-272`).
- No dynamic `href={…}`/`style=` bindings with note data in Svelte components (only `MediaView.svelte` with the encoded `/api/file` URL). API URLs encode every query value (`web/src/lib/api.ts:74, 168`).
- Server side: no HTML templating; JSON responses only; user files served with `nosniff`, `attachment` for HTML, SVG sandboxed (see FILE_UPLOADS).
- Second line of defense: CSP `script-src 'self'`, `object-src 'none'`, `base-uri 'self'`.

### XSS-1 (Info): renderer keeps external `https:` images, CSP blocks them

`render.ts:224-226` keeps `<img src="https://…">` (no-referrer, lazy), but CSP `img-src 'self' data: blob:` (`server/http/app.ts:129`) blocks them, so they show as broken images. Security-wise the CSP behaviour is the better one (no tracking pixels / IP leaks from agent-written notes). Decide one way and make both layers agree: either drop external images in the renderer (show a link instead), or allow them deliberately in CSP.

### XSS-2 (Info): Mermaid output trusted after its own sanitizer

`securityLevel: 'strict'` is the correct setting and Mermaid blocks `securityLevel` changes via `%%{init}%%` directives. Mermaid has had sanitizer bypasses in the past; CSP without inline script is the backstop. Keep Mermaid up to date (it is a dev dependency bundled into the frontend, so `npm audit --omit=dev` does **not** cover it — check the full `npm audit`).

## What's at risk

No exploitable XSS found. A sanitizer bypass would still be stopped by the CSP from running script, though HTML/CSS injection could restyle the page.

## What's already secure

See findings: layered sanitizing, attribute-free raw HTML, protocol allowlists, KaTeX `trust: false`, Mermaid strict mode, strict CSP, no HTML tooltips.

## Recommendations

1. Resolve XSS-1 consistently (recommended: renderer drops external images or turns them into links).
2. Watch Mermaid/KaTeX/rehype-sanitize advisories via the full `npm audit` (they are devDependencies but ship to the browser).

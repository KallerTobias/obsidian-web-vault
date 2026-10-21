import type { Mermaid } from 'mermaid';

/*
 * Mermaid diagrams: `renderMarkdown` keeps the source in `pre.mermaid-src`; here they become SVG in the
 * browser. Mermaid is large, so it is loaded on the first note that has a diagram. `securityLevel:
 * 'strict'` makes Mermaid sanitize labels and refuse click handlers / scripts in the diagram source.
 */

let loading: Promise<Mermaid> | null = null;
let seq = 0;

function load(): Promise<Mermaid> {
  loading ??= import('mermaid').then(({ default: mermaid }) => mermaid);
  return loading;
}

const isDark = () => document.documentElement.dataset.theme === 'dark';

/** Replaces each `pre.mermaid-src` in `root` by its diagram; a diagram that fails keeps its source with a hint. */
export async function renderMermaid(root: HTMLElement): Promise<void> {
  const sources = [...root.querySelectorAll<HTMLElement>('pre.mermaid-src')];
  if (sources.length === 0) return;
  const mermaid = await load();
  mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: isDark() ? 'dark' : 'default' });
  for (const pre of sources) {
    if (!pre.isConnected) continue;
    const id = `vw-mermaid-${++seq}`;
    try {
      const { svg } = await mermaid.render(id, pre.textContent ?? '');
      const figure = document.createElement('div');
      figure.className = 'mermaid';
      figure.innerHTML = svg;
      pre.replaceWith(figure);
    } catch {
      pre.classList.add('mermaid-error');
      // Mermaid leaves its error graphic in the body.
      document.getElementById('d' + id)?.remove();
    }
  }
}

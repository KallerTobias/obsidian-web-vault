<script lang="ts" module>
  import type { GraphData } from '../api';
  import type { GraphNode, GraphSettings, Position } from './data';

  /** From this zoom level (2D) on, every node shows its name; below it only the focused ones. */
  export const LABEL_ZOOM = 1.4;

  export type GraphMode = '2d' | '3d';

  /** A node as the graph libraries hold it (they add coordinates and velocities). */
  type SimNode = GraphNode & { x?: number; y?: number; z?: number; vx?: number; vy?: number; vz?: number };
  type SimLink = { source: unknown; target: unknown };

  /** Force functions from d3-force(-3d); only the knobs used here. */
  interface Force {
    strength?: (v: number) => Force;
    distance?: (v: number) => Force;
  }

  /**
   * The part of `force-graph` / `3d-force-graph` used here (both are kapsule components with
   * chainable setters). Kept structural so both libraries and test doubles fit.
   */
  export interface GraphInstance {
    graphData(): { nodes: SimNode[]; links: SimLink[] };
    graphData(data: { nodes: SimNode[]; links: SimLink[] }): GraphInstance;
    width(w: number): GraphInstance;
    height(h: number): GraphInstance;
    nodeId(id: string): GraphInstance;
    nodeLabel(fn: (n: SimNode) => string | HTMLElement): GraphInstance;
    linkColor(fn: (l: SimLink) => string): GraphInstance;
    onNodeClick(fn: (n: SimNode, e: MouseEvent) => void): GraphInstance;
    onNodeHover(fn: (n: SimNode | null) => void): GraphInstance;
    onEngineStop(fn: () => void): GraphInstance;
    zoomToFit(ms?: number, padding?: number): GraphInstance;
    d3Force(name: string): Force | undefined;
    d3Force(name: string, force: unknown): GraphInstance;
    d3ReheatSimulation(): GraphInstance;
    pauseAnimation(): GraphInstance;
    _destructor(): void;
    // 2D only
    nodeCanvasObject?(fn: (n: SimNode, ctx: CanvasRenderingContext2D, scale: number) => void): GraphInstance;
    nodeCanvasObjectMode?(fn: () => string): GraphInstance;
    nodePointerAreaPaint?(fn: (n: SimNode, color: string, ctx: CanvasRenderingContext2D, scale: number) => void): GraphInstance;
    // 3D only
    backgroundColor?(c: string): GraphInstance;
    nodeColor?(fn: (n: SimNode) => string): GraphInstance;
    nodeVal?(fn: (n: SimNode) => number): GraphInstance;
    nodeRelSize?(v: number): GraphInstance;
    nodeResolution?(v: number): GraphInstance;
    linkOpacity?(v: number): GraphInstance;
    showNavInfo?(v: boolean): GraphInstance;
  }

  type GraphConstructor = new (el: HTMLElement, options?: object) => GraphInstance;

  /** Both libraries are loaded on demand, each into its own chunk (3D brings three.js). */
  async function loadLibrary(mode: GraphMode): Promise<GraphConstructor> {
    if (mode === '3d') return (await import('3d-force-graph')).default as unknown as GraphConstructor;
    return (await import('force-graph')).default as unknown as GraphConstructor;
  }

  interface Palette {
    node: string;
    tag: string;
    attachment: string;
    unresolved: string;
    focused: string;
    line: string;
    text: string;
    background: string;
    font: string;
  }

  /** Colours from the theme tokens (light/dark), with fallbacks where no stylesheet is loaded. */
  function readPalette(): Palette {
    const cs = getComputedStyle(document.documentElement);
    const v = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback;
    return {
      node: v('--graph-node', '#8a8a8a'),
      tag: v('--graph-node-tag', '#2f9e44'),
      attachment: v('--graph-node-attachment', '#e8a317'),
      unresolved: v('--graph-node-unresolved', '#c4c4c4'),
      focused: v('--graph-node-focused', '#7c3aed'),
      line: v('--graph-line', '#d4d4d4'),
      text: v('--graph-text', '#222222'),
      background: v('--background-primary', '#ffffff'),
      font: v('--font-interface', 'sans-serif'),
    };
  }

  /** `#rgb`/`#rrggbb` with an alpha as `rgba()`; other colour forms are returned unchanged. */
  export function withAlpha(color: string, alpha: number): string {
    let hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color)?.[1];
    if (!hex) return color;
    if (hex.length === 3) hex = hex.replace(/./g, (c) => c + c);
    const n = parseInt(hex, 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
  }

  /** Pulls every node towards the origin (keeps unconnected parts on screen); d3's `center` only shifts the mean. */
  function gravity(strength: number) {
    let nodes: SimNode[] = [];
    const force = (alpha: number) => {
      const k = strength * alpha;
      for (const n of nodes) {
        n.vx = (n.vx ?? 0) - (n.x ?? 0) * k;
        n.vy = (n.vy ?? 0) - (n.y ?? 0) * k;
        if (n.z !== undefined) n.vz = (n.vz ?? 0) - n.z * k;
      }
    };
    force.initialize = (ns: SimNode[]) => {
      nodes = ns;
    };
    return force;
  }
</script>

<script lang="ts">
  import { untrack } from 'svelte';
  import { t } from '../i18n';
  import { adjacency, colorFor, endId, nodeRadius, withPositions } from './data';

  /**
   * Force-directed graph (2D canvas via `force-graph`, 3D WebGL via `3d-force-graph`). Shows `data`
   * as given (filtering is the caller's job); colours, sizes and forces come from `settings`.
   * Switching `mode` replaces the renderer and keeps the layout.
   */
  let {
    data,
    settings,
    mode = '2d',
    highlight,
    label = t.graph.label,
    fit = false,
    onOpen,
    onTag,
    onUnresolved,
  }: {
    data: GraphData | null;
    settings: GraphSettings;
    mode?: GraphMode;
    /** Node drawn emphasised (the local graph's note). */
    highlight?: string;
    label?: string;
    /** Zoom to fit everything whenever the layout settles (small graphs). */
    fit?: boolean;
    /** A note or attachment was clicked. */
    onOpen?: (path: string, newTab: boolean) => void;
    /** A tag node was clicked (tag without `#`). */
    onTag?: (tag: string) => void;
    /** An unresolved link was clicked (its target as written). */
    onUnresolved?: (name: string, newTab: boolean) => void;
  } = $props();

  let container = $state<HTMLDivElement>();
  let instance = $state.raw<GraphInstance>();
  let failed = $state(false);
  let palette = $state.raw<Palette>(readPalette());
  /** The last renderer's layout, for the next one (2D/3D switch). */
  let positions: Position[] = [];
  let hovered: string | null = null;
  let neighbours = new Set<string>();

  /** Unchanged values do not propagate: effects rerun only when what they use really changed. */
  const currentMode = $derived(mode);
  const graph = $derived(data);
  const adj = $derived(adjacency(graph?.links ?? []));
  /** Primitive keys: effects only rerun when the parts they use change, not on every settings change. */
  const forcesKey = $derived(`${settings.repel}|${settings.linkDistance}|${settings.center}`);
  const styleKey = $derived(JSON.stringify([settings.groups, settings.nodeSize, highlight ?? '']));
  /** Base colour per node id (group colour or kind colour). */
  const colors = $derived.by(() => {
    void styleKey;
    const nodes = graph?.nodes ?? [];
    const p = palette;
    return untrack(() => new Map(nodes.map((n) => [n.id, baseColor(n, p)])));
  });

  function baseColor(n: GraphNode, p: Palette): string {
    if (n.id === highlight) return p.focused;
    const group = colorFor(n, settings.groups);
    if (group) return group;
    return n.kind === 'tag' ? p.tag : n.kind === 'attachment' ? p.attachment : n.kind === 'unresolved' ? p.unresolved : p.node;
  }

  const isLit = (id: string) => hovered === null || id === hovered || neighbours.has(id);
  const radius = (n: SimNode) => nodeRadius(n.degree, settings.nodeSize) * (n.id === highlight ? 1.3 : 1);

  function alphaOf(n: SimNode): number {
    if (!isLit(n.id)) return 0.15;
    return n.kind === 'unresolved' ? 0.6 : 1;
  }

  function linkColor(l: SimLink): string {
    if (hovered === null) return palette.line;
    const touches = endId(l.source) === hovered || endId(l.target) === hovered;
    return touches ? palette.focused : withAlpha(palette.line, 0.2);
  }

  function draw(n: SimNode, ctx: CanvasRenderingContext2D, scale: number): void {
    const x = n.x ?? 0;
    const y = n.y ?? 0;
    const r = radius(n);
    ctx.globalAlpha = alphaOf(n);
    ctx.fillStyle = colors.get(n.id) ?? palette.node;
    ctx.beginPath();
    if (n.kind === 'attachment') ctx.rect(x - r * 0.85, y - r * 0.85, r * 1.7, r * 1.7);
    else ctx.arc(x, y, r, 0, 2 * Math.PI);
    ctx.fill();
    const focused = hovered !== null && isLit(n.id);
    if (scale >= LABEL_ZOOM || focused || n.id === highlight) {
      ctx.font = `${12 / scale}px ${palette.font}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillStyle = palette.text;
      ctx.fillText(n.name, x, y + r + 2 / scale);
    }
    ctx.globalAlpha = 1;
  }

  function hitArea(n: SimNode, color: string, ctx: CanvasRenderingContext2D): void {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(n.x ?? 0, n.y ?? 0, radius(n) + 1, 0, 2 * Math.PI);
    ctx.fill();
  }

  /** Re-sets the style accessors: the libraries redraw (2D) or recolour (3D) on a new accessor. */
  function restyle(inst: GraphInstance): void {
    inst.linkColor((l) => linkColor(l));
    if (inst.nodeCanvasObject) inst.nodeCanvasObject((n, ctx, scale) => draw(n, ctx, scale));
    else {
      inst.nodeColor?.((n) => withAlpha(colors.get(n.id) ?? palette.node, alphaOf(n)));
      inst.nodeVal?.((n) => radius(n) ** 3);
    }
  }

  function click(n: SimNode, e: MouseEvent): void {
    const newTab = e.ctrlKey || e.metaKey;
    if (n.kind === 'tag') onTag?.(n.name.replace(/^#/, ''));
    else if (n.kind === 'unresolved') onUnresolved?.(n.name, newTab);
    else onOpen?.(n.id, newTab);
  }

  function configure(inst: GraphInstance, m: GraphMode, el: HTMLElement): void {
    inst
      .nodeId('id')
      .width(el.clientWidth || 300)
      .height(el.clientHeight || 300)
      .onNodeClick(click)
      .onNodeHover((n) => {
        hovered = n?.id ?? null;
        neighbours = hovered === null ? new Set() : (adj.get(hovered) ?? new Set());
        el.style.cursor = n ? 'pointer' : '';
        restyle(inst);
      })
      .onEngineStop(() => {
        if (fit) inst.zoomToFit(300, 16);
      });
    if (m === '2d') {
      // Labels are drawn on the canvas; the library's tooltip would render names as HTML.
      inst.nodeLabel(() => '');
      inst.nodeCanvasObjectMode?.(() => 'replace');
      inst.nodePointerAreaPaint?.((n, color, ctx) => hitArea(n, color, ctx));
    } else {
      // Names as text nodes (never HTML): a note name may contain markup.
      inst.nodeLabel((n) => {
        const span = document.createElement('span');
        span.textContent = n.name;
        return span;
      });
      inst.backgroundColor?.(palette.background);
      inst.nodeRelSize?.(1);
      inst.nodeResolution?.(8);
      inst.linkOpacity?.(0.5);
      inst.showNavInfo?.(false);
    }
  }

  // The renderer: created per mode, destroyed on mode switch and unmount.
  $effect(() => {
    const el = container;
    const m = currentMode;
    if (!el) return;
    let cancelled = false;
    let inst: GraphInstance | undefined;
    failed = false;
    const resize = new ResizeObserver(() => inst?.width(el.clientWidth).height(el.clientHeight));
    loadLibrary(m)
      .then((Graph) => {
        if (cancelled) return;
        inst = new Graph(el, m === '3d' ? { controlType: 'orbit' } : undefined);
        configure(inst, m, el);
        resize.observe(el);
        instance = inst;
      })
      .catch(() => {
        if (!cancelled) failed = true;
      });
    return () => {
      cancelled = true;
      resize.disconnect();
      instance = undefined;
      if (!inst) return;
      positions = inst.graphData().nodes.map(({ id, x, y, z }) => ({ id, x, y, z }));
      inst.pauseAnimation();
      inst._destructor();
      el.replaceChildren();
    };
  });

  // Data: existing nodes keep their place (from the running layout, or the previous renderer's).
  $effect(() => {
    const inst = instance;
    const d = graph ?? { nodes: [], links: [] };
    if (!inst) return;
    const current = inst.graphData().nodes;
    inst.graphData({
      nodes: withPositions(d.nodes, current.length ? current : positions),
      links: d.links.map((l) => ({ source: l.source, target: l.target })),
    });
    hovered = null;
    neighbours = new Set();
  });

  // Forces (relative multipliers of d3's defaults).
  $effect(() => {
    const inst = instance;
    void forcesKey;
    if (!inst) return;
    const { repel, linkDistance, center } = untrack(() => settings);
    inst.d3Force('charge')?.strength?.(-40 * repel);
    inst.d3Force('link')?.distance?.(30 * linkDistance);
    inst.d3Force('gravity', gravity(0.04 * center));
    inst.d3ReheatSimulation();
  });

  // Colours and sizes.
  $effect(() => {
    const inst = instance;
    void colors;
    if (!inst) return;
    inst.backgroundColor?.(palette.background);
    restyle(inst);
  });

  // Theme switches change the tokens.
  $effect(() => {
    const observer = new MutationObserver(() => (palette = readPalette()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  });
</script>

<div class="graph-canvas">
  <div bind:this={container} class="surface" role="img" aria-label={label}></div>
  {#if failed}<p class="failed" role="alert">{t.graph.renderFailed}</p>{/if}
</div>

<style>
  .graph-canvas {
    position: relative;
    width: 100%;
    height: 100%;
    min-height: 0;
  }
  .surface {
    position: absolute;
    inset: 0;
    overflow: hidden;
  }
  .failed {
    position: absolute;
    inset: auto var(--size-4) var(--size-4);
    margin: 0;
    font-size: var(--font-ui-small);
    color: var(--text-error);
  }
</style>

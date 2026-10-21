import type { TreeEntry } from './api';

/** Pure helpers for the file tree and path bookkeeping (vault-relative, "/"-separated paths). */

/** `p` is `path` itself or lies below it (when `path` is a folder). '' is the vault root. */
export const isAtOrBelow = (p: string, path: string) => path === '' || p === path || p.startsWith(`${path}/`);

/** Maps `p` through a rename of `from` → `to`: the entry itself, or anything below a renamed folder. */
export function movePath(p: string, from: string, to: string): string {
  if (p === from) return to;
  return p.startsWith(`${from}/`) ? to + p.slice(from.length) : p;
}

export const isNotePath = (p: string) => p.toLowerCase().endsWith('.md');

/** Name as shown: notes without `.md`. */
export const displayName = (e: { name: string; kind: string }) => (e.kind === 'note' ? e.name.slice(0, -3) : e.name);

/** One visible line of the tree. */
export interface TreeRow {
  entry: TreeEntry;
  /** 1 for entries in the vault root. */
  level: number;
  /** Index of the parent folder's row; -1 at the top level. */
  parent: number;
  /** Position among its siblings (1-based) and their count, for aria-posinset/-setsize. */
  posinset: number;
  setsize: number;
  expanded: boolean;
}

/**
 * The rows to show: entries in tree order, children only below expanded folders. Collapsed
 * folders cost nothing, so a large vault stays cheap until folders are opened.
 */
export function visibleRows(root: TreeEntry, expanded: ReadonlySet<string>): TreeRow[] {
  const rows: TreeRow[] = [];
  const walk = (children: TreeEntry[], level: number, parent: number) => {
    children.forEach((entry, i) => {
      const open = entry.kind === 'folder' && expanded.has(entry.path);
      rows.push({ entry, level, parent, posinset: i + 1, setsize: children.length, expanded: open });
      if (open && entry.children) walk(entry.children, level + 1, rows.length - 1);
    });
  };
  walk(root.children ?? [], 1, -1);
  return rows;
}

export function findEntry(root: TreeEntry, path: string): TreeEntry | undefined {
  if (path === '') return root;
  let node: TreeEntry | undefined = root;
  for (const part of path.split('/')) {
    node = node?.children?.find((c) => c.name === part);
    if (!node) return undefined;
  }
  return node;
}

/** All folder paths ('' = root first), for move targets. */
export function folderPaths(root: TreeEntry): string[] {
  const out = [''];
  const walk = (e: TreeEntry) => {
    for (const c of e.children ?? []) {
      if (c.kind !== 'folder') continue;
      out.push(c.path);
      walk(c);
    }
  };
  walk(root);
  return out;
}

/** `stem.ext`, or `stem 1.ext`, `stem 2.ext` … — the first name not taken in `folder` (case-insensitive). */
export function uniqueChildName(folder: TreeEntry | undefined, stem: string, ext = ''): string {
  const taken = new Set((folder?.children ?? []).map((c) => c.name.toLowerCase()));
  for (let i = 0; ; i++) {
    const name = `${i === 0 ? stem : `${stem} ${i}`}${ext}`;
    if (!taken.has(name.toLowerCase())) return name;
  }
}

/** Notes below `folder` (recursively), e.g. the templates. */
export function notesBelow(root: TreeEntry, folder: string): TreeEntry[] {
  const start = findEntry(root, folder);
  const out: TreeEntry[] = [];
  const walk = (e: TreeEntry) => {
    for (const c of e.children ?? []) {
      if (c.kind === 'note') out.push(c);
      else if (c.kind === 'folder') walk(c);
    }
  };
  if (start?.kind === 'folder') walk(start);
  return out;
}

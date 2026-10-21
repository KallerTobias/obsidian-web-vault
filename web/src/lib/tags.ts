export interface TagNode {
  /** Last segment (`todo` for `projekt/alpha/todo`). */
  name: string;
  /** Full tag without `#`. */
  tag: string;
  /** Uses of exactly this tag. */
  own: number;
  /** Own uses plus those of all subtags. */
  count: number;
  children: TagNode[];
}

/** Nests `a/b/c` tags; a parent's count includes its own uses and its children's. Siblings are sorted by name. */
export function buildTagTree(tags: readonly { tag: string; count: number }[]): TagNode[] {
  const roots: TagNode[] = [];
  const byTag = new Map<string, TagNode>();
  for (const { tag, count } of tags) {
    const parts = tag.split('/').filter(Boolean);
    let siblings = roots;
    for (let i = 0; i < parts.length; i++) {
      const full = parts.slice(0, i + 1).join('/');
      let node = byTag.get(full);
      if (!node) {
        node = { name: parts[i]!, tag: full, own: 0, count: 0, children: [] };
        byTag.set(full, node);
        siblings.push(node);
      }
      node.count += count;
      if (i === parts.length - 1) node.own += count;
      siblings = node.children;
    }
  }
  const sort = (nodes: TagNode[]) => {
    nodes.sort((a, b) => a.name.localeCompare(b.name, 'de', { sensitivity: 'base' }));
    for (const n of nodes) sort(n.children);
  };
  sort(roots);
  return roots;
}

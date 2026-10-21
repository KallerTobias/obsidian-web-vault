import { parseNote } from '../../shared/parse';
import type { ParsedNote } from '../../shared/types';
import { basename, dirname, nfc, stripMd } from '../../shared/normalize';
import { linkKey, lookupKey, resolveLink, type FileLookup } from '../../shared/resolve';

export interface IndexedNote extends ParsedNote {
  path: string;
  /** Parallel to `links`: resolved real path, or null. Same-note links resolve to the note itself. */
  resolved: (string | null)[];
}

export interface Backlink {
  source: string;
  contexts: { line: number; text: string }[];
}

export interface GraphData {
  nodes: {
    id: string;
    name: string;
    kind: 'note' | 'attachment' | 'tag' | 'unresolved';
    tags: string[];
    folder: string;
    degree: number;
  }[];
  links: { source: string; target: string }[];
}

interface Entry {
  note: IndexedNote;
  text: string;
  /** Parallel to links: linkKey of the target ('' for same-note links). */
  keys: string[];
}

const isNote = (p: string) => p.toLowerCase().endsWith('.md');

function lineText(text: string, from: number): string {
  const s = text.lastIndexOf('\n', from - 1) + 1;
  let e = text.indexOf('\n', from);
  if (e < 0) e = text.length;
  return text.slice(s, e).replace(/\r$/, '').trim();
}

function tagPrefixes(tag: string): string[] {
  const parts = tag.split('/');
  return parts.map((_, i) => parts.slice(0, i + 1).join('/'));
}

export class VaultIndex {
  private files = new Set<string>();
  private entries = new Map<string, Entry>();
  private lk: FileLookup = { byPath: new Map(), byBasename: new Map() };
  /** target path -> sources linking to it (self excluded) */
  private reverse = new Map<string, Set<string>>();
  /** linkKey -> sources having a link with that key (may list a source more than once) */
  private byKey = new Map<string, string[]>();
  /** linkKey of every known file -> how many files have it */
  private names = new Map<string, number>();
  private tagCounts = new Map<string, number>();

  lookup(): FileLookup {
    return this.lk;
  }

  note(path: string): IndexedNote | undefined {
    return this.entries.get(path)?.note;
  }

  upsert(path: string, text: string): void {
    const old = this.entries.get(path);
    if (old) this.dropEntry(path, old);
    const isNew = this.registerFile(path);
    const parsed = parseNote(text);
    const keys = parsed.links.map((l) => (l.target === '' ? '' : linkKey(l.target)));
    const resolved = parsed.links.map((l, i) =>
      l.target === '' ? path : this.resolve(l.target, keys[i]!, path),
    );
    const note = Object.assign(parsed, { path, resolved });
    this.entries.set(path, { note, text, keys });
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i]!;
      if (k !== '') {
        // Duplicates are harmless: re-resolving a source twice is idempotent.
        const list = this.byKey.get(k);
        if (list) list.push(path);
        else this.byKey.set(k, [path]);
      }
      this.addReverse(resolved[i], path);
    }
    for (const t of parsed.tags) this.bumpTag(t.tag, 1);
    if (isNew) this.reresolve(linkKey(path));
  }

  /** Registers a non-note file (attachment). */
  addFile(path: string): void {
    if (this.registerFile(path)) this.reresolve(linkKey(path));
  }

  remove(path: string): void {
    const old = this.entries.get(path);
    if (old) {
      this.dropEntry(path, old);
      this.entries.delete(path);
    }
    if (!this.files.delete(path)) return;
    this.lk.byPath.delete(lookupKey(path));
    const nk = linkKey(path);
    const cnt = (this.names.get(nk) ?? 1) - 1;
    if (cnt > 0) this.names.set(nk, cnt);
    else this.names.delete(nk);
    const bk = lookupKey(basename(path));
    const list = this.lk.byBasename.get(bk)?.filter((p) => p !== path);
    if (list && list.length > 0) this.lk.byBasename.set(bk, list);
    else this.lk.byBasename.delete(bk);
    this.reresolve(linkKey(path));
  }

  backlinks(path: string): Backlink[] {
    const out: Backlink[] = [];
    for (const src of [...(this.reverse.get(path) ?? [])].sort()) {
      const e = this.entries.get(src);
      if (!e) continue;
      const contexts: Backlink['contexts'] = [];
      e.note.links.forEach((l, i) => {
        if (e.note.resolved[i] !== path) return;
        if (!contexts.some((c) => c.line === l.line)) {
          contexts.push({ line: l.line, text: lineText(e.text, l.from) });
        }
      });
      out.push({ source: src, contexts });
    }
    return out;
  }

  unlinkedMentions(path: string): Backlink[] {
    const target = this.entries.get(path);
    if (!target) return [];
    const names = [stripMd(basename(path)), ...target.note.aliases]
      .map((n) => nfc(n).trim())
      .filter((n) => n !== '');
    if (names.length === 0) return [];
    const esc = names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const re = new RegExp(`(?<![\\p{L}\\p{N}_])(?:${esc.join('|')})(?![\\p{L}\\p{N}_])`, 'giu');
    const out: Backlink[] = [];
    for (const [src, e] of this.entries) {
      if (src === path || this.reverse.get(path)?.has(src)) continue;
      const fmEnd = e.note.frontmatterRange?.to ?? 0;
      const contexts: Backlink['contexts'] = [];
      let line = 0;
      let pos = 0;
      re.lastIndex = fmEnd;
      for (let m = re.exec(e.text); m; m = re.exec(e.text)) {
        const at = m.index;
        if (e.note.links.some((l) => at >= l.from && at < l.to)) continue;
        for (let nl = e.text.indexOf('\n', pos); nl >= 0 && nl < at; nl = e.text.indexOf('\n', pos)) {
          line++;
          pos = nl + 1;
        }
        if (!contexts.some((c) => c.line === line)) contexts.push({ line, text: lineText(e.text, at) });
      }
      if (contexts.length > 0) out.push({ source: src, contexts });
    }
    return out.sort((a, b) => (a.source < b.source ? -1 : 1));
  }

  /** Unresolved link targets (as written, without ".md") -> sources. */
  unresolved(): Map<string, string[]> {
    const out = new Map<string, string[]>();
    for (const [src, e] of this.entries) {
      e.note.links.forEach((l, i) => {
        if (e.note.resolved[i] !== null) return;
        const name = stripMd(l.target);
        const list = out.get(name);
        if (!list) out.set(name, [src]);
        else if (!list.includes(src)) list.push(src);
      });
    }
    return out;
  }

  /** Tag (without "#") -> count of occurrences; `a/b` also counts for `a`. */
  tags(): Map<string, number> {
    return new Map(this.tagCounts);
  }

  graph(): GraphData {
    const nodes = new Map<string, GraphData['nodes'][number]>();
    const links: GraphData['links'] = [];
    const seen = new Set<string>();
    const node = (id: string, name: string, kind: GraphData['nodes'][number]['kind'], folder: string, tags: string[]) => {
      let n = nodes.get(id);
      if (!n) nodes.set(id, (n = { id, name, kind, tags, folder, degree: 0 }));
      return n;
    };
    const edge = (s: string, t: string) => {
      const key = s + '\0' + t;
      if (s === t || seen.has(key)) return;
      seen.add(key);
      links.push({ source: s, target: t });
      nodes.get(s)!.degree++;
      nodes.get(t)!.degree++;
    };
    for (const [path, e] of this.entries) {
      const tags = [...new Set(e.note.tags.map((t) => t.tag))];
      node(path, stripMd(basename(path)), 'note', dirname(path), tags);
    }
    for (const [path, e] of this.entries) {
      e.note.links.forEach((l, i) => {
        const r = e.note.resolved[i] ?? null;
        if (r === path) return;
        if (r === null) {
          const name = stripMd(l.target);
          node('unresolved:' + name, name, 'unresolved', '', []);
          edge(path, 'unresolved:' + name);
        } else {
          if (!nodes.has(r)) node(r, basename(r), 'attachment', dirname(r), []);
          edge(path, r);
        }
      });
      for (const t of new Set(e.note.tags.map((x) => x.tag))) {
        node('tag:#' + t, '#' + t, 'tag', '', []);
        edge(path, 'tag:#' + t);
      }
    }
    return { nodes: [...nodes.values()], links };
  }

  // --- internals ---

  /** Adds the file to the lookup tables; false if it was already known. */
  private registerFile(path: string): boolean {
    if (this.files.has(path)) return false;
    this.files.add(path);
    this.lk.byPath.set(lookupKey(path), path);
    const nk = linkKey(path);
    this.names.set(nk, (this.names.get(nk) ?? 0) + 1);
    const bk = lookupKey(basename(path));
    const list = this.lk.byBasename.get(bk);
    if (list) list.push(path);
    else this.lk.byBasename.set(bk, [path]);
    return true;
  }

  private dropEntry(path: string, e: Entry): void {
    e.note.resolved.forEach((r) => this.delReverse(r, path));
    for (const k of new Set(e.keys)) {
      const list = this.byKey.get(k);
      if (!list) continue;
      const rest = list.filter((x) => x !== path);
      if (rest.length > 0) this.byKey.set(k, rest);
      else this.byKey.delete(k);
    }
    for (const t of e.note.tags) this.bumpTag(t.tag, -1);
  }

  /** Re-resolves links with the given key (after a file with that name appeared or disappeared). */
  private reresolve(key: string): void {
    const sources = this.byKey.get(key);
    if (!sources) return;
    for (const src of sources) {
      const e = this.entries.get(src);
      if (!e) continue;
      const keys = e.keys;
      for (let i = 0; i < keys.length; i++) {
        const k = keys[i]!;
        if (k !== key) continue;
        const next = this.resolve(e.note.links[i]!.target, k, src);
        const prev = e.note.resolved[i] ?? null;
        if (next === prev) continue;
        e.note.resolved[i] = next;
        // Another link of the same note may still point to the old target.
        if (prev !== null && !e.note.resolved.includes(prev)) this.delReverse(prev, src);
        this.addReverse(next, src);
      }
    }
  }

  /** resolveLink with a cheap pre-check: some file must have the target's name. */
  private resolve(target: string, key: string, source: string): string | null {
    if (!this.names.has(key)) return null;
    return resolveLink(target, source, this.lk);
  }

  private addTo(m: Map<string, Set<string>>, k: string, v: string): void {
    const s = m.get(k);
    if (s) s.add(v);
    else m.set(k, new Set([v]));
  }

  private addReverse(target: string | null | undefined, source: string): void {
    if (target && target !== source) this.addTo(this.reverse, target, source);
  }

  private delReverse(target: string | null | undefined, source: string): void {
    if (!target || target === source) return;
    const s = this.reverse.get(target);
    if (!s) return;
    s.delete(source);
    if (s.size === 0) this.reverse.delete(target);
  }

  private bumpTag(tag: string, d: number): void {
    for (const p of tagPrefixes(tag)) {
      const n = (this.tagCounts.get(p) ?? 0) + d;
      if (n <= 0) this.tagCounts.delete(p);
      else this.tagCounts.set(p, n);
    }
  }
}

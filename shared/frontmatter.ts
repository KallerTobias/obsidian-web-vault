import { Document, isMap, isSeq, parseDocument, stringify, type Pair, type YAMLMap } from 'yaml';
import { findFrontmatter } from './parse';

export type FmChange =
  | { op: 'set'; key: string; value: unknown }
  | { op: 'delete'; key: string }
  | { op: 'rename'; from: string; to: string };

/*
 * Format-preserving frontmatter edits. The `yaml` library is used to validate the block, to locate the lines of
 * each top-level key and to serialize new values; the block itself is edited line by line, so every untouched
 * line (comments, quoting, blank lines, key order, line endings) stays byte-identical.
 * Frontmatter detection is shared with parse.ts (findFrontmatter).
 */

interface Entry {
  pair: Pair;
  keyName: string;
  first: number; // line index of the key
  last: number; // line index of the last line of its value
}

function parseBlock(lines: string[]): { map: YAMLMap | null; entries: Entry[] } {
  const src = lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l)).join('\n');
  const doc = parseDocument(src, { logLevel: 'silent' });
  if (doc.errors.length > 0) throw new Error(`Ungültiges Frontmatter: ${doc.errors[0]!.message}`);
  if (doc.contents == null) return { map: null, entries: [] };
  if (!isMap(doc.contents)) throw new Error('Ungültiges Frontmatter: kein Schlüssel-Wert-Block');
  const starts = [0];
  for (let i = 0; i < src.length; i++) if (src.charCodeAt(i) === 10) starts.push(i + 1);
  const lineOf = (off: number): number => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid]! <= off) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
  const entries: Entry[] = [];
  for (const pair of doc.contents.items) {
    const keyRange = (pair.key as { range?: [number, number, number] | null } | null)?.range;
    if (!keyRange) throw new Error('Ungültiges Frontmatter: Schlüssel ohne Position');
    const first = lineOf(keyRange[0]);
    const valRange = (pair.value as { range?: [number, number, number] | null } | null)?.range;
    let last = valRange ? lineOf(Math.max(keyRange[1], valRange[1] - 1)) : first;
    while (last > first && src.split('\n')[last]!.trim() === '') last--; // block scalars swallow trailing blank lines
    entries.push({ pair, keyName: String((pair.key as { value?: unknown }).value ?? pair.key), first, last });
  }
  return { map: doc.contents, entries };
}

function serializePair(key: string, value: unknown, old: Entry | undefined, oldLines: string[]): string[] {
  const doc = new Document({ [key]: value });
  const node = doc.get(key, true);
  const oldValue = old?.pair.value;
  if ((isSeq(node) || isMap(node)) && (isSeq(oldValue) || isMap(oldValue)) && oldValue.flow) node.flow = true;
  const oldText = old ? oldLines.slice(old.first, old.last + 1).join('\n') : '';
  const text = doc.toString({
    lineWidth: 0,
    indentSeq: !/^-/m.test(oldText.split('\n').slice(1).join('\n')) || !old,
    flowCollectionPadding: /\[\s|\{\s/.test(oldText),
  });
  return text.replace(/\n$/, '').split('\n');
}

function applyChange(lines: string[], change: FmChange, eol: string): string[] {
  const { entries } = parseBlock(lines);
  const find = (k: string): Entry | undefined => entries.find((e) => e.keyName === k);
  const out = lines.slice();
  switch (change.op) {
    case 'set': {
      const old = find(change.key);
      const fresh = serializePair(change.key, change.value, old, lines).map((l) => l + (eol === '\r\n' ? '\r' : ''));
      if (old) out.splice(old.first, old.last - old.first + 1, ...fresh);
      else out.push(...fresh);
      return out;
    }
    case 'delete': {
      const old = find(change.key);
      if (old) out.splice(old.first, old.last - old.first + 1);
      return out;
    }
    case 'rename': {
      const old = find(change.from);
      if (!old || change.from === change.to) return out;
      if (find(change.to)) throw new Error(`Frontmatter-Schlüssel existiert bereits: ${change.to}`);
      const keyRange = (old.pair.key as { range: [number, number, number] }).range;
      const src = lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l)).join('\n');
      const lineStart = src.lastIndexOf('\n', keyRange[0] - 1) + 1;
      const line = out[old.first]!;
      const newKey = stringify(change.to).replace(/\n$/, '');
      out[old.first] = line.slice(0, keyRange[0] - lineStart) + newKey + line.slice(keyRange[1] - lineStart);
      return out;
    }
  }
}

/** Applies `changes` to the frontmatter of `text`, touching only the lines of the affected keys. Throws on invalid YAML. */
export function updateFrontmatter(text: string, changes: FmChange[]): string {
  if (changes.length === 0) return text;
  const bom = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  const nl = text.indexOf('\n');
  const eol = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const fm = findFrontmatter(text, bom);

  if (!fm) {
    if (!changes.some((c) => c.op === 'set')) return text;
    let lines: string[] = [];
    for (const c of changes) lines = applyChange(lines, c, eol);
    if (lines.length === 0) return text;
    return text.slice(0, bom) + ['---', ...lines.map((l) => l.replace(/\r$/, '')), '---'].join(eol) + eol + text.slice(bom);
  }

  // fm.yaml is the text between the opening line and the closing delimiter line (ends with a line break or is empty).
  const yamlLines = fm.yaml === '' ? [] : fm.yaml.replace(/\n$/, '').split('\n');
  let lines = yamlLines;
  parseBlock(lines); // validate even if no change applies
  for (const c of changes) lines = applyChange(lines, c, eol);
  const yamlStart = text.indexOf('\n', bom) + 1;
  const newYaml = lines.length === 0 ? '' : lines.join('\n') + '\n';
  return text.slice(0, yamlStart) + newYaml + text.slice(yamlStart + fm.yaml.length);
}

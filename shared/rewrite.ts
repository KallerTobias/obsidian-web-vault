import { dirname } from './normalize';
import { linkTextFor, lookupKey, resolveLink, type FileLookup } from './resolve';
import type { LinkRef } from './types';

/** Same token as the parser's markdown link destination: `<...>` or a run without spaces/unbalanced parens. */
const MD_DEST_RE = /\(\s*(<[^>\n]*>|(?:[^()\s]|\([^()\s]*\))+)/y;
const SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;

type Form = 'basename' | 'relative' | 'absolute';

/**
 * Rewrites the links of one note after files were renamed/moved.
 *
 * - `links` / `resolvedTo`: the note's links and their targets resolved BEFORE the rename (old paths).
 * - `renames`: old path -> new path for every moved file (folder moves expanded to files).
 * - `sourcePath`: the note's path AFTER the rename; `files`: the lookup AFTER the rename.
 *
 * A link is only touched if it pointed to a moved file (or the note itself moved) and its
 * current text no longer resolves to the new path. The written form is kept: basename stays
 * basename while unique, relative stays relative, vault paths stay vault paths, `.md` is kept or
 * left out as before, markdown links stay URL-encoded. Only the bytes of changed links differ.
 */
export function rewriteLinks(
  text: string,
  links: LinkRef[],
  resolvedTo: (string | null)[],
  renames: Map<string, string>,
  sourcePath: string,
  files: FileLookup,
): string {
  let oldSource = sourcePath;
  for (const [from, to] of renames) {
    if (to === sourcePath) {
      oldSource = from;
      break;
    }
  }
  const sourceMoved = oldSource !== sourcePath;

  let out = '';
  let copied = 0;
  links.forEach((l, i) => {
    const old = resolvedTo[i] ?? null;
    if (old === null || l.target === '') return;
    const next = renames.get(old) ?? old;
    if (next === old && !sourceMoved) return;
    if (resolveLink(l.target, sourcePath, files) === next) return;
    const raw = l.raw.startsWith('[[') || l.raw.startsWith('![[') ? rewriteWiki(l, next, oldSource, sourcePath, old, files) : rewriteMarkdown(l, next, oldSource, sourcePath, old, files);
    if (raw === null || raw === l.raw) return;
    out += text.slice(copied, l.from) + raw;
    copied = l.to;
  });
  return copied === 0 ? text : out + text.slice(copied);
}

/** How the link was written: file name only, relative to the source folder, or vault path. */
function formOf(target: string, oldSource: string, oldTarget: string): Form {
  if (target.startsWith('./') || target.startsWith('../')) return 'relative';
  if (!target.includes('/')) return 'basename';
  const dir = dirname(oldSource);
  if (dir !== '') {
    const joined = lookupKey(dir + '/' + target);
    const real = lookupKey(oldTarget);
    if (joined === real || joined + '.md' === real) return 'relative';
  }
  return 'absolute';
}

/** Link path for `next` in the given form; falls back to another form if the preferred one is ambiguous. */
function newTarget(form: Form, next: string, source: string, files: FileLookup, keepMd: boolean): string {
  const withExt = (p: string) => (keepMd && next.endsWith('.md') && !p.endsWith('.md') ? p + '.md' : p);
  const candidates: Record<Form, () => string> = {
    basename: () => withExt(linkTextFor(next, source, files, 'shortest')),
    relative: () => withExt(linkTextFor(next, source, files, 'relative')),
    absolute: () => withExt(linkTextFor(next, source, files, 'absolute')),
  };
  const order: Form[] = form === 'relative' ? ['relative', 'absolute'] : form === 'basename' ? ['basename', 'absolute'] : ['absolute', 'relative'];
  const first = candidates[order[0]!]();
  if (resolveLink(first, source, files) === next) return first;
  const second = candidates[order[1]!]();
  return resolveLink(second, source, files) === next ? second : first;
}

function rewriteWiki(l: LinkRef, next: string, oldSource: string, source: string, old: string, files: FileLookup): string | null {
  const open = l.raw.indexOf('[[') + 2;
  const inner = l.raw.slice(open, -2);
  const pipe = inner.indexOf('|');
  let pathEnd = pipe < 0 ? inner.length : pipe;
  if (pipe > 0 && inner[pipe - 1] === '\\') pathEnd = pipe - 1;
  const hash = inner.indexOf('#');
  const end = hash >= 0 && hash < pathEnd ? hash : pathEnd;
  const seg = inner.slice(0, end);
  const lead = seg.length - seg.trimStart().length;
  const trail = seg.length - seg.trimEnd().length;
  const keepMd = l.target.toLowerCase().endsWith('.md');
  const target = newTarget(formOf(l.target, oldSource, old), next, source, files, keepMd);
  const at = open + lead;
  return l.raw.slice(0, at) + target + l.raw.slice(open + end - trail);
}

function rewriteMarkdown(l: LinkRef, next: string, oldSource: string, source: string, old: string, files: FileLookup): string | null {
  const sep = l.raw.indexOf('](');
  if (sep < 0) return null;
  MD_DEST_RE.lastIndex = sep + 1;
  const m = MD_DEST_RE.exec(l.raw);
  if (!m) return null;
  const dest = m[1]!;
  const destStart = sep + 1 + m[0].length - dest.length;
  const angle = dest.startsWith('<');
  const url = angle ? dest.slice(1, -1) : dest;
  const hash = url.indexOf('#');
  const pathPart = hash < 0 ? url : url.slice(0, hash);
  const keepMd = l.target.toLowerCase().endsWith('.md');
  const target = newTarget(formOf(l.target, oldSource, old), next, source, files, keepMd);
  const encoded = angle ? encodeAngle(target) : encodePath(target);
  const at = destStart + (angle ? 1 : 0);
  return l.raw.slice(0, at) + encoded + l.raw.slice(at + pathPart.length);
}

/** URL-encodes a vault path per segment so the parser decodes it back exactly (spaces, `#`, `%`, `(`, `)`, `?`, non-ASCII). */
function encodePath(p: string): string {
  const out = p
    .split('/')
    .map((s) => encodeURI(s).replace(/[#?()]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase()))
    .join('/');
  return SCHEME_RE.test(out) ? out.replace(':', '%3A') : out;
}

/** Inside `<...>` spaces may stay; only characters that would break the link or its decoding are encoded. */
function encodeAngle(p: string): string {
  const out = p.replace(/[%#<>]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  return SCHEME_RE.test(out) ? out.replace(':', '%3A') : out;
}

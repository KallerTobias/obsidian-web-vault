import type { BlockParser, DelimiterType, Element, MarkdownConfig } from '@lezer/markdown';
import { tags, Tag } from '@lezer/highlight';

/** Highlighting tags for Obsidian syntax (styled in `setup.ts`). */
export const obsidianTags = {
  wikiLink: Tag.define(tags.link),
  tag: Tag.define(tags.labelName),
  highlight: Tag.define(),
};

const OPEN_BRACKET = 91; // [
const CLOSE_BRACKET = 93; // ]
const BANG = 33; // !
const HASH = 35; // #
const EQUALS = 61; // =
const DOLLAR = 36; // $
const PERCENT = 37; // %

/** `[[Ziel|Text]]` and embeds `![[Ziel]]` (no line breaks inside). */
const WikiLink: MarkdownConfig = {
  defineNodes: [
    { name: 'WikiLink', style: obsidianTags.wikiLink },
    { name: 'WikiLinkMark', style: tags.processingInstruction },
  ],
  parseInline: [
    {
      name: 'WikiLink',
      parse(cx, next, pos) {
        const embed = next === BANG;
        const open = embed ? pos + 1 : pos;
        if ((!embed && next !== OPEN_BRACKET) || cx.char(open) !== OPEN_BRACKET || cx.char(open + 1) !== OPEN_BRACKET)
          return -1;
        for (let i = open + 2; i < cx.end - 1; i++) {
          const c = cx.char(i);
          if (c === 10) return -1;
          if (c === CLOSE_BRACKET && cx.char(i + 1) === CLOSE_BRACKET) {
            if (i === open + 2) return -1; // `[[]]`
            return cx.addElement(
              cx.elt('WikiLink', pos, i + 2, [cx.elt('WikiLinkMark', pos, open + 2), cx.elt('WikiLinkMark', i, i + 2)]),
            );
          }
        }
        return -1;
      },
      before: 'Link',
    },
  ],
};

/** Same rule as the reading view: letters, digits, `_`, `-`, `/`; not only digits; after a space or line start. */
const TAG_CHAR = /[\p{L}\p{N}_\-/]/u;

const Tag_: MarkdownConfig = {
  defineNodes: [{ name: 'Tag', style: obsidianTags.tag }],
  parseInline: [
    {
      name: 'Tag',
      parse(cx, next, pos) {
        if (next !== HASH) return -1;
        const before = cx.slice(pos - 1, pos);
        if (before !== '' && !/\s/.test(before)) return -1;
        let end = pos + 1;
        while (end < cx.end) {
          const ch = String.fromCodePoint(cx.slice(end, end + 2).codePointAt(0)!);
          if (!TAG_CHAR.test(ch)) break;
          end += ch.length;
        }
        const name = cx.slice(pos + 1, end);
        if (name === '' || /^\d+$/.test(name)) return -1;
        return cx.addElement(cx.elt('Tag', pos, end));
      },
    },
  ],
};

const HighlightDelim: DelimiterType = { resolve: 'Highlight', mark: 'HighlightMark' };

/** `==markiert==`. */
const Highlight: MarkdownConfig = {
  defineNodes: [
    { name: 'Highlight', style: { 'Highlight/...': obsidianTags.highlight } },
    { name: 'HighlightMark', style: tags.processingInstruction },
  ],
  parseInline: [
    {
      name: 'Highlight',
      parse(cx, next, pos) {
        if (next !== EQUALS || cx.char(pos + 1) !== EQUALS || cx.char(pos + 2) === EQUALS) return -1;
        const before = cx.slice(pos - 1, pos);
        const after = cx.slice(pos + 2, pos + 3);
        const sBefore = /\s|^$/.test(before);
        const sAfter = /\s|^$/.test(after);
        return cx.addDelimiter(HighlightDelim, pos, pos + 2, !sAfter, !sBefore);
      },
      after: 'Emphasis',
    },
  ],
};

/**
 * A block that runs from a line starting with `open` (not closed on that line) to the end of the line that
 * contains the next `open` (or the end of the container). Its content is not parsed: no formatting inside.
 */
function fencedLeaf(name: string, open: string): BlockParser[] {
  return [
    {
      name,
      parse(cx, line) {
        const text = line.text.slice(line.pos);
        if (!text.startsWith(open) || text.indexOf(open, open.length) >= 0) return false;
        const from = cx.lineStart + line.pos;
        const children: Element[] = [];
        // Stop where the container ends (as FencedCode does). `Line.depth` is internal and not in the
        // typings; verified against @lezer/markdown 1.8.1 – recheck the cast when updating it.
        while (cx.nextLine() && (line as unknown as { depth: number }).depth >= cx.depth) {
          children.push(...line.markers);
          if (line.text.includes(open, line.pos)) {
            const end = cx.lineStart + line.text.length;
            cx.nextLine();
            cx.addElement(cx.elt(name, from, end, children));
            return true;
          }
        }
        cx.addElement(cx.elt(name, from, cx.prevLineEnd(), children));
        return true;
      },
      before: 'FencedCode',
    },
  ];
}

/** `$x$` (no space inside the dollars, no digit after the closing one), `$$x$$` inline, and `$$` blocks. */
const Math_: MarkdownConfig = {
  defineNodes: [{ name: 'InlineMath' }, { name: 'BlockMath', block: true }],
  parseInline: [
    {
      name: 'InlineMath',
      parse(cx, next, pos) {
        if (next !== DOLLAR) return -1;
        if (cx.char(pos + 1) === DOLLAR) {
          const close = cx.slice(pos + 2, cx.end).indexOf('$$');
          return close <= 0 ? -1 : cx.addElement(cx.elt('InlineMath', pos, pos + 2 + close + 2));
        }
        const first = cx.char(pos + 1);
        if (first === -1 || first === 10 || first === 32 || first === 9) return -1;
        for (let i = pos + 2; i < cx.end; i++) {
          const c = cx.char(i);
          if (c === 92) i++; // `\$` is part of the formula
          else if (c === DOLLAR) {
            const before = cx.char(i - 1);
            const after = cx.char(i + 1);
            if (before === 32 || before === 9 || before === 10 || (after >= 48 && after <= 57)) continue;
            return cx.addElement(cx.elt('InlineMath', pos, i + 1));
          }
        }
        return -1;
      },
      before: 'Emphasis',
    },
  ],
  parseBlock: fencedLeaf('BlockMath', '$$'),
};

/** `%%Kommentar%%`, inline or as a block over several lines; not rendered in reading mode. */
const Comment: MarkdownConfig = {
  defineNodes: [
    { name: 'ObsidianComment', style: tags.comment },
    { name: 'ObsidianCommentBlock', block: true, style: tags.comment },
  ],
  parseInline: [
    {
      name: 'ObsidianComment',
      parse(cx, next, pos) {
        if (next !== PERCENT || cx.char(pos + 1) !== PERCENT) return -1;
        const close = cx.slice(pos + 2, cx.end).indexOf('%%');
        return close < 0 ? -1 : cx.addElement(cx.elt('ObsidianComment', pos, pos + 2 + close + 2));
      },
      before: 'Emphasis',
    },
  ],
  parseBlock: fencedLeaf('ObsidianCommentBlock', '%%'),
};

/** Obsidian additions to GFM. */
export const obsidianMarkdown: MarkdownConfig[] = [WikiLink, Tag_, Highlight, Math_, Comment];

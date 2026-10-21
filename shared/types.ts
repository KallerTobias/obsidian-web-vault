/**
 * Types produced by the note parser (`parseNote`).
 *
 * Conventions (relied upon by backlink contexts, `data-line` checkboxes, ...):
 * - `from` / `to` are UTF-16 string indices (JS `string` indices) into the ORIGINAL text,
 *   including a leading BOM and `\r\n` line endings. `to` is exclusive.
 * - `line` is 0-BASED (first line of the text = 0) and counts lines of the whole text,
 *   frontmatter included. Lines are separated by `\n` (a preceding `\r` belongs to the break).
 */

export interface LinkRef {
  /**
   * 'wikilink' = `[[x]]`; 'embed' = `![[x]]` or `![alt](x)`;
   * 'markdown' = `[t](x)` for ANY internal target, i.e. every target without a URL scheme (`https:`, `mailto:`, ...)
   * and not starting with `//` - notes (`x.md`) as well as attachments (`[x](file.pdf)`) and same-note anchors
   * (`[x](#h)`, target ''). Callers that only want note links must filter on the target's extension.
   */
  kind: 'wikilink' | 'embed' | 'markdown';
  /**
   * Link path as written, trimmed, NFC. Wikilinks: no `.md` added/removed.
   * Markdown links: URL-decoded (`%20` -> space), `.md` kept. May be '' for same-note links (`[[#Kopf]]`).
   */
  target: string;
  /** Part after the first `#` (heading text or `^blockid`), without the `#`. */
  subpath?: string;
  /** Wikilink/embed: text after `|` (embed: e.g. size '300'). Markdown: the link text, if non-empty. */
  alias?: string;
  /** The exact source text of the link. */
  raw: string;
  from: number;
  to: number;
  /** 0-based line number of `from`. */
  line: number;
}

export interface TagRef {
  /** Tag without the leading `#`, NFC (e.g. 'a/b'). */
  tag: string;
  /** Body tags: range of `#tag` in the text. Frontmatter tags: range of the value if found, else the frontmatter range. */
  from: number;
  to: number;
  source: 'body' | 'frontmatter';
}

export interface Heading {
  level: number;
  /** Heading text without the leading `#`s and optional closing `#`s, trimmed. */
  text: string;
  /** 0-based line number. */
  line: number;
  /** Index of the first `#` of the heading. */
  from: number;
}

export interface ParsedNote {
  links: LinkRef[];
  tags: TagRef[];
  headings: Heading[];
  /** Block IDs (`text ^abc` at line end) without the `^`. */
  blockIds: string[];
  /** Parsed YAML mapping; null if there is no frontmatter, or it is invalid / not a mapping. */
  frontmatter: Record<string, unknown> | null;
  /**
   * Range from the opening `---` (after an optional BOM) to the end of the closing
   * `---`/`...` (excluding its line break). Set whenever a frontmatter block exists, even if its YAML is invalid.
   */
  frontmatterRange: { from: number; to: number } | null;
  /** From frontmatter `aliases` / `alias` (list or comma-separated string). */
  aliases: string[];
}

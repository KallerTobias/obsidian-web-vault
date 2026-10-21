import { autocompletion, closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search';
import { Annotation, Compartment, EditorSelection, EditorState, type Extension, type Text } from '@codemirror/state';
import { drawSelection, EditorView, keymap } from '@codemirror/view';
import { tags } from '@lezer/highlight';
import type { FileLookup } from '@shared/resolve';
import { t } from '../i18n';
import { tagCompletions, wikilinkCompletions, type WikilinkSource } from './autocomplete';
import { obsidianKeymap } from './keymap';
import { pasteImages, type PasteOptions } from './paste';
import { livePreview, refreshLinks, type LivePreviewContext } from './live-preview';
import { obsidianMarkdown, obsidianTags } from './syntax';

export type EditorMode = 'live' | 'source';

export interface EditorOptions {
  doc: string;
  mode: EditorMode;
  readonly: boolean;
  /** Vault path of the note (for extensions that resolve links, embeds and attachments). */
  path: string;
  /** The vault's current link lookup (live mode resolves links with it; none: every link is unresolved). */
  lookup?: () => FileLookup;
  /** A rendered link was clicked (live mode). */
  openLink?: LivePreviewContext['openLink'];
  /** A rendered tag was clicked (live mode); the tag without `#`. */
  openTag?: LivePreviewContext['openTag'];
  /** Text of a vault note, for embeds `![[Notiz]]` in live mode. */
  loadNote?: (path: string) => Promise<string>;
  /** Data for `[[` and `#` completion; none: no completion. */
  completion?: {
    /** Notes and files with aliases/headings, the link format and lookup (read when the completion opens). */
    links: () => Pick<WikilinkSource, 'entries' | 'files' | 'format'>;
    /** Tags of the vault without `#`, most used first. */
    tags: () => readonly string[];
  };
  /** Paste/drop of files: upload and link (none: files are not handled). */
  attachments?: PasteOptions;
  /** The user changed the text (not called for `replaceDoc`). */
  onChange: (doc: string) => void;
}

export interface EditorHandle {
  view: EditorView;
  setMode(mode: EditorMode): void;
  /** Shows `text` (e.g. reloaded from disk) without reporting a change; `keepSelection` keeps cursor (line/column) and scroll position. */
  replaceDoc(text: string, keepSelection: boolean): void;
  /** The vault's links changed (`lookup` returns something new): resolve the rendered links again. */
  refreshLinks(): void;
  destroy(): void;
}

/** Marks transactions that load text from outside (not typed): they are not reported as changes. */
const external = Annotation.define<boolean>();

/** Colours come from the theme tokens (light/dark). */
const highlightStyle = HighlightStyle.define([
  { tag: [tags.heading1, tags.heading2, tags.heading3, tags.heading4, tags.heading5, tags.heading6], fontWeight: '700' },
  { tag: tags.strong, fontWeight: '700' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.strikethrough, textDecoration: 'line-through' },
  { tag: [tags.link, tags.url, obsidianTags.wikiLink], color: 'var(--text-accent)' },
  { tag: obsidianTags.tag, color: 'var(--text-accent)' },
  { tag: obsidianTags.highlight, backgroundColor: 'var(--text-highlight-bg, rgba(255, 208, 0, 0.4))' },
  { tag: [tags.processingInstruction, tags.contentSeparator, tags.quote], color: 'var(--text-muted)' },
  { tag: tags.monospace, fontFamily: 'var(--font-monospace)' },
  { tag: [tags.meta, tags.comment], color: 'var(--text-faint)' },
  // Code blocks (languages load lazily).
  { tag: [tags.keyword, tags.operatorKeyword, tags.modifier], color: 'var(--code-keyword, #a626a4)' },
  { tag: [tags.string, tags.special(tags.string)], color: 'var(--code-string, #50a14f)' },
  { tag: [tags.number, tags.bool, tags.null, tags.atom], color: 'var(--code-value, #986801)' },
  { tag: [tags.function(tags.variableName), tags.definition(tags.variableName)], color: 'var(--code-function, #4078f2)' },
  { tag: [tags.typeName, tags.className], color: 'var(--code-type, #c18401)' },
  { tag: tags.propertyName, color: 'var(--code-property, #e45649)' },
]);

/** Heading sizes in the source mode (the live preview sizes whole heading lines instead). */
const sourceHeadings = syntaxHighlighting(
  HighlightStyle.define([
    { tag: tags.heading1, fontSize: '1.6em' },
    { tag: tags.heading2, fontSize: '1.4em' },
    { tag: tags.heading3, fontSize: '1.2em' },
  ]),
);

const theme = EditorView.theme({
  '&': { height: '100%', backgroundColor: 'transparent', color: 'var(--text-normal)' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'var(--font-text)', lineHeight: 'var(--line-height)', overflow: 'auto' },
  '&.is-source .cm-scroller': { fontFamily: 'var(--font-monospace)', fontSize: '0.9em' },
  '.cm-content': { maxWidth: '720px', margin: '0 auto', padding: 'var(--size-6) var(--size-5)', caretColor: 'var(--text-normal)' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--text-normal)' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, ::selection': {
    backgroundColor: 'var(--text-selection)',
  },
  '.cm-panels': { backgroundColor: 'var(--background-secondary)', color: 'var(--text-normal)' },
  '.cm-panels.cm-panels-top': { borderBottom: '1px solid var(--background-modifier-border)' },
  '.cm-searchMatch': { backgroundColor: 'var(--text-highlight-bg, rgba(255, 208, 0, 0.4))' },
  '.cm-selectionMatch': { backgroundColor: 'var(--background-modifier-hover)' },
});

/** Code-block languages: `language-data` loads each language on first use (own chunk), the list itself lazily too. */
async function codeLanguages(): Promise<Extension> {
  const { languages } = await import('@codemirror/language-data');
  return markdown({ base: markdownLanguage, codeLanguages: languages, extensions: obsidianMarkdown });
}

const noLookup: FileLookup = { byPath: new Map(), byBasename: new Map() };

const modeExtensions = (mode: EditorMode, opts: EditorOptions): Extension => [
  EditorView.editorAttributes.of({ class: mode === 'source' ? 'is-source' : 'is-live' }),
  mode === 'live'
    ? livePreview({ path: opts.path, lookup: opts.lookup ?? (() => noLookup), openLink: opts.openLink ?? (() => {}), openTag: opts.openTag, loadNote: opts.loadNote })
    : sourceHeadings,
];

/** Clamped position of `line`/`col` (1-based line) in `doc`. */
function atLineCol(doc: Text, line: number, col: number): number {
  const l = doc.line(Math.min(Math.max(line, 1), doc.lines));
  return l.from + Math.min(col, l.length);
}

/** The Markdown editor (CodeMirror 6) for one note. */
export function createEditor(parent: HTMLElement, opts: EditorOptions): EditorHandle {
  const mode = new Compartment();
  const language = new Compartment();
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: opts.doc,
      extensions: [
        history(),
        drawSelection(),
        EditorView.lineWrapping,
        closeBrackets(),
        search({ top: true }),
        highlightSelectionMatches(),
        opts.completion
          ? autocompletion({
              icons: false,
              override: [
                (ctx) => wikilinkCompletions(ctx, { ...opts.completion!.links(), sourcePath: opts.path }),
                (ctx) => tagCompletions(ctx, opts.completion!.tags()),
              ],
            })
          : [],
        opts.attachments ? pasteImages(opts.attachments) : [],
        keymap.of([...obsidianKeymap, ...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, indentWithTab]),
        language.of(markdown({ base: markdownLanguage, extensions: obsidianMarkdown })),
        syntaxHighlighting(highlightStyle),
        theme,
        EditorState.readOnly.of(opts.readonly),
        // CRLF files stay CRLF (by default CodeMirror would write every line break as LF).
        opts.doc.includes('\r\n') ? EditorState.lineSeparator.of('\r\n') : [],
        EditorView.contentAttributes.of({ 'aria-label': t.editor.editorLabel, spellcheck: 'true' }),
        mode.of(modeExtensions(opts.mode, opts)),
        EditorView.updateListener.of((u) => {
          if (u.docChanged && !u.transactions.some((t) => t.annotation(external))) opts.onChange(u.state.sliceDoc());
        }),
      ],
    }),
  });
  let destroyed = false;
  void codeLanguages().then(
    (ext) => {
      if (!destroyed) view.dispatch({ effects: language.reconfigure(ext) });
    },
    () => {
      /* offline: code blocks stay unhighlighted */
    },
  );

  return {
    view,
    setMode(m) {
      view.dispatch({ effects: mode.reconfigure(modeExtensions(m, opts)) });
    },
    replaceDoc(text, keepSelection) {
      const old = view.state;
      if (old.sliceDoc() === text) return;
      const scrollTop = view.scrollDOM.scrollTop;
      let selection: EditorSelection | undefined;
      if (keepSelection) {
        const newDoc = old.toText(text);
        const map = (pos: number) => {
          const line = old.doc.lineAt(pos);
          return atLineCol(newDoc, line.number, pos - line.from);
        };
        selection = EditorSelection.create(
          old.selection.ranges.map((r) => EditorSelection.range(map(r.anchor), map(r.head))),
          old.selection.mainIndex,
        );
      }
      view.dispatch({
        changes: { from: 0, to: old.doc.length, insert: text },
        selection: selection ?? EditorSelection.cursor(0),
        annotations: external.of(true),
      });
      if (keepSelection) view.scrollDOM.scrollTop = scrollTop;
    },
    refreshLinks() {
      view.dispatch({ effects: refreshLinks.of(null) });
    },
    destroy() {
      destroyed = true;
      view.destroy();
    },
  };
}

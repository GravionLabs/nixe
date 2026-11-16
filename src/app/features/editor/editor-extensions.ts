import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { syntaxTree } from "@codemirror/language";
import { openSearchPanel, search, searchKeymap, searchPanelOpen } from "@codemirror/search";
import { EditorState, Extension, Range } from "@codemirror/state";
import {
  Decoration,
  DecorationSet,
  EditorView,
  ViewPlugin,
  ViewUpdate,
  Command,
  drawSelection,
  keymap,
} from "@codemirror/view";

import { CompletionData, completionExtension } from "./completion";
import { inlineTokens, nodeClass, tokenAt } from "../../core/editor/editor-core";

const CODE_NODES = new Set(["FencedCode", "CodeBlock", "InlineCode", "CommentBlock", "HTMLBlock"]);

export function inCode(state: EditorState, pos: number): boolean {
  for (let node: { name: string; parent: unknown } | null = syntaxTree(state).resolveInner(pos, 1); node; ) {
    if (CODE_NODES.has(node.name)) return true;
    node = node.parent as typeof node;
  }
  return false;
}

function build(view: EditorView): DecorationSet {
  const { state } = view;
  const ranges: Range<Decoration>[] = [];
  for (const { from, to } of view.visibleRanges) {
    syntaxTree(state).iterate({
      from,
      to,
      enter(node) {
        const cls = nodeClass(node.name);
        if (cls && node.to > node.from) ranges.push(Decoration.mark({ class: cls }).range(node.from, node.to));
      },
    });
    for (let pos = from; pos <= to; ) {
      const line = state.doc.lineAt(pos);
      if (line.length > 0 && (line.text.includes("[[") || line.text.includes("#")) && !inCode(state, line.from)) {
        for (const t of inlineTokens(line.text)) {
          ranges.push(
            Decoration.mark({ class: t.kind === "wikilink" ? "cm-wikilink" : "cm-tag" }).range(
              line.from + t.from,
              line.from + t.to,
            ),
          );
        }
      }
      pos = line.to + 1;
    }
  }
  return Decoration.set(ranges, true);
}

/** Heading sizes, bold, italic, code, dimmed syntax characters, `[[wikilinks]]` and `#tags`. */
export const markdownStyling = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = build(view);
    }
    update(update: ViewUpdate): void {
      if (update.docChanged || update.viewportChanged || syntaxTree(update.startState) !== syntaxTree(update.state)) {
        this.decorations = build(update.view);
      }
    }
  },
  { decorations: (plugin) => plugin.decorations },
);

/** Colors come from the app's CSS variables, so the editor follows the theme without a rebuild. */
export function editorTheme(dark: boolean, fontSizePx: number): Extension {
  const heading = (size: number) => ({ fontSize: `${size}em`, fontWeight: "700" });
  return EditorView.theme(
    {
      "&": { height: "100%", fontSize: `${fontSizePx}px`, color: "var(--fg)", backgroundColor: "var(--bg)" },
      "&.cm-focused": { outline: "none" },
      ".cm-scroller": { overflow: "auto", fontFamily: "inherit", lineHeight: "1.6" },
      ".cm-content": { maxWidth: "980px", margin: "0 auto", padding: "32px 40px 80px", caretColor: "var(--fg)" },
      ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--fg)" },
      "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground": {
        background: dark ? "rgb(63 184 194 / 0.3)" : "rgb(14 124 134 / 0.25)",
      },
      ".cm-md-h1": heading(1.8),
      ".cm-md-h2": heading(1.5),
      ".cm-md-h3": heading(1.25),
      ".cm-md-h4": heading(1.1),
      ".cm-md-h5": heading(1),
      ".cm-md-h6": { ...heading(1), color: "var(--muted)" },
      ".cm-md-strong": { fontWeight: "700" },
      ".cm-md-em": { fontStyle: "italic" },
      ".cm-md-code": {
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
        backgroundColor: "var(--chrome)",
        borderRadius: "3px",
      },
      ".cm-md-syntax": { opacity: "0.4" },
      ".cm-wikilink": { color: "var(--accent)", textDecoration: "underline" },
      ".cm-tag": { color: "var(--accent)" },
      ".cm-tooltip": { backgroundColor: "var(--chrome)", color: "var(--fg)", border: "1px solid var(--muted)" },
      ".cm-tooltip.cm-tooltip-autocomplete > ul > li": { padding: "2px 8px" },
      ".cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]": {
        backgroundColor: "var(--accent)",
        color: "var(--bg)",
      },
      ".cm-panels": { backgroundColor: "var(--chrome)", color: "var(--fg)" },
      ".cm-panels-top": { borderBottom: "1px solid var(--muted)" },
      ".cm-search": { padding: "6px 10px", fontSize: "0.85em" },
      ".cm-search input, .cm-search button": {
        color: "var(--fg)",
        backgroundColor: "var(--bg)",
        border: "1px solid var(--muted)",
        borderRadius: "3px",
        backgroundImage: "none",
      },
      ".cm-search button:hover": { backgroundColor: "var(--chrome)" },
      ".cm-search label": { color: "var(--fg)" },
      ".cm-search [name=close]": { color: "var(--fg)", border: "none", backgroundColor: "transparent" },
      ".cm-search:not(.cm-replace-on) input[name=replace], .cm-search:not(.cm-replace-on) button[name=replace], .cm-search:not(.cm-replace-on) button[name=replaceAll]":
        { display: "none" },
      ".cm-searchMatch": { backgroundColor: "rgb(255 200 0 / 0.35)" },
      ".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: "rgb(255 140 0 / 0.6)" },
      ".cm-completionDetail": { opacity: "0.6", marginLeft: "0.8em", fontStyle: "normal" },
    },
    { dark },
  );
}

/** Class of the search panel while replace is shown (⌘/Ctrl+⌥+F); plain ⌘/Ctrl+F hides it. */
export const REPLACE_CLASS = "cm-replace-on";

/** Opens the find bar; with `replace` the replace field is shown and focused. */
export function openFind(view: EditorView, replace: boolean): boolean {
  if (!searchPanelOpen(view.state)) openSearchPanel(view);
  const panel = view.dom.querySelector<HTMLElement>(".cm-search");
  panel?.classList.toggle(REPLACE_CLASS, replace);
  const field = panel?.querySelector<HTMLInputElement>(replace ? "input[name=replace]" : "input[name=search]");
  field?.focus();
  field?.select();
  return true;
}

const findCommand: Command = (view) => openFind(view, false);
const replaceCommand: Command = (view) => openFind(view, true);

export interface EditorHooks {
  onSave(): void;
  onBlur(): void;
  /** ⌘/Ctrl+click on a `[[wikilink]]`; `value` is the text between the brackets. */
  onWikilink(value: string): void;
  /** Vault data for the `[[` and `#` completion; without it the editor does not complete. */
  completion?: CompletionData;
}

/** Extensions that do not depend on the theme. */
export function editorBehavior(hooks: EditorHooks): Extension[] {
  return [
    history(),
    keymap.of([
      {
        key: "Mod-s",
        preventDefault: true,
        run: () => {
          hooks.onSave();
          return true;
        },
      },
      { key: "Mod-f", run: findCommand, preventDefault: true },
      { key: "Mod-Alt-f", run: replaceCommand, preventDefault: true },
      ...searchKeymap,
      ...defaultKeymap,
      ...historyKeymap,
    ]),
    markdown(),
    drawSelection(),
    search({ top: true }),
    EditorView.lineWrapping,
    markdownStyling,
    ...(hooks.completion ? [completionExtension(hooks.completion)] : []),
    EditorView.domEventHandlers({
      blur: () => {
        hooks.onBlur();
      },
      mousedown(event, view) {
        if (!(event.metaKey || event.ctrlKey) || event.button !== 0) return false;
        const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
        if (pos === null) return false;
        const line = view.state.doc.lineAt(pos);
        const token = tokenAt(line.text, pos - line.from, "wikilink");
        if (!token) return false;
        event.preventDefault();
        hooks.onWikilink(token.value);
        return true;
      },
    }),
  ];
}

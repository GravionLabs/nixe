import {
  codeFolding,
  foldAll,
  foldCode,
  foldEffect,
  foldGutter,
  foldKeymap,
  foldService,
  foldedRanges,
  unfoldAll,
  unfoldCode,
  unfoldEffect,
} from "@codemirror/language";
import type { EditorState, Extension, Text } from "@codemirror/state";
import type { ViewUpdate } from "@codemirror/view";
import { EditorView, keymap } from "@codemirror/view";

import type { FoldRange } from "../../core/fold/fold-core";
import { foldRanges } from "../../core/fold/fold-core";

const cache = new WeakMap<Text, Map<number, FoldRange>>();

/** The foldable ranges of the document by start line; computed once per document version. */
function rangesOf(doc: Text): Map<number, FoldRange> {
  let ranges = cache.get(doc);
  if (!ranges) {
    ranges = new Map(foldRanges(doc.toString()).map((r) => [r.line, r]));
    cache.set(doc, ranges);
  }
  return ranges;
}

/** What can be folded at a line: from the end of the line to the end of the last hidden one. */
const markdownFolds = foldService.of((state, lineStart) => {
  const line = state.doc.lineAt(lineStart);
  const range = rangesOf(state.doc).get(line.number);
  if (!range) return null;
  return { from: line.to, to: state.doc.line(Math.min(range.endLine, state.doc.lines)).to };
});

/** The 1-based start lines of the folds that are closed now. */
export function foldedLines(state: EditorState): number[] {
  const lines: number[] = [];
  foldedRanges(state).between(0, state.doc.length, (from) => {
    lines.push(state.doc.lineAt(from).number);
  });
  return lines;
}

/** Closes the folds that start at these lines; lines that cannot fold (any more) are skipped. */
export function restoreFolds(view: EditorView, lines: readonly number[]): void {
  const ranges = rangesOf(view.state.doc);
  const effects = lines.flatMap((n) => {
    const range = ranges.get(n);
    if (!range) return [];
    const line = view.state.doc.line(n);
    return [
      foldEffect.of({
        from: line.to,
        to: view.state.doc.line(Math.min(range.endLine, view.state.doc.lines)).to,
      }),
    ];
  });
  if (effects.length) view.dispatch({ effects });
}

export type FoldAction = "fold" | "unfold" | "fold-all" | "unfold-all";

/** Runs one of the fold commands; the cursor line is the one that folds or unfolds. */
export function foldAction(view: EditorView, action: FoldAction): boolean {
  switch (action) {
    case "fold":
      return foldCode(view);
    case "unfold":
      return unfoldCode(view);
    case "fold-all":
      return foldAll(view);
    case "unfold-all":
      return unfoldAll(view);
  }
}

/**
 * Folding of frontmatter, headings and list items: a gutter marker, the fold commands on keys and
 * a placeholder. `onChange` gets the closed folds' start lines whenever they change.
 */
export function folding(onChange: (lines: number[]) => void): Extension[] {
  let last = "";
  return [
    markdownFolds,
    codeFolding({ placeholderText: "…" }),
    foldGutter({ openText: "▾", closedText: "▸" }),
    keymap.of(foldKeymap),
    EditorView.updateListener.of((update: ViewUpdate) => {
      const foldChanged = update.transactions.some((t) =>
        t.effects.some((e) => e.is(foldEffect) || e.is(unfoldEffect)),
      );
      if (!foldChanged && !update.docChanged) return;
      const lines = foldedLines(update.state);
      const key = lines.join(",");
      if (key === last) return;
      last = key;
      onChange(lines);
    }),
  ];
}

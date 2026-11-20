// @vitest-environment jsdom
import { foldable } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it, vi } from "vitest";

import { editorBehavior } from "./editor-extensions";
import { foldAction, folding, foldedLines, restoreFolds } from "./folding";

const DOC = "---\ntitle: A\n---\n# H1\ntext\n- item\n  child\n## H2\nmore\n# H3\nend";

function make(onChange: (l: number[]) => void = () => {}): EditorView {
  return new EditorView({
    state: EditorState.create({
      doc: DOC,
      extensions: [editorBehavior({ onSave: () => {}, onBlur: () => {}, onWikilink: () => {} }), folding(onChange)],
    }),
    parent: document.body,
  });
}

describe("editor folding", () => {
  it("offers folds for frontmatter, headings and list items", () => {
    const view = make();
    const at = (n: number) => foldable(view.state, view.state.doc.line(n).from, view.state.doc.line(n).to);
    expect(at(1)).not.toBeNull();
    expect(at(4)).not.toBeNull();
    expect(at(6)).not.toBeNull();
    expect(at(5)).toBeNull();
    view.destroy();
  });

  it("folds all, unfolds all and reports the closed lines", () => {
    const seen: number[][] = [];
    const view = make((l) => seen.push(l));
    foldAction(view, "fold-all");
    expect(foldedLines(view.state)).toEqual([1, 4, 10]);
    expect(seen.at(-1)).toEqual(foldedLines(view.state));
    foldAction(view, "unfold-all");
    expect(foldedLines(view.state)).toEqual([]);
    expect(seen.at(-1)).toEqual([]);
    view.destroy();
  });

  it("folds and unfolds at the cursor line", () => {
    const view = make();
    view.dispatch({ selection: { anchor: view.state.doc.line(4).from } });
    foldAction(view, "fold");
    expect(foldedLines(view.state)).toEqual([4]);
    foldAction(view, "unfold");
    expect(foldedLines(view.state)).toEqual([]);
    view.destroy();
  });

  it("restores remembered folds and skips lines that cannot fold", () => {
    const view = make();
    restoreFolds(view, [1, 5, 99, 8]);
    expect(foldedLines(view.state)).toEqual([1, 8]);
    view.destroy();
  });

  it("does not report anything for plain typing", () => {
    const onChange = vi.fn();
    const view = make(onChange);
    view.dispatch({ changes: { from: 0, insert: "x" } });
    expect(onChange).not.toHaveBeenCalled();
    view.destroy();
  });
});

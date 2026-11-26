// @vitest-environment jsdom
import { history, undo } from "@codemirror/commands";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it, vi } from "vitest";

import { dispatchText, textChange } from "./text-change";

describe("textChange", () => {
  it("is null for equal texts", () => {
    expect(textChange("abc", "abc")).toBeNull();
  });

  it("covers only the differing part", () => {
    expect(textChange("a: 1\nb: 2\n", "a: 1\nb: 3\n")).toEqual({ from: 8, to: 9, insert: "3" });
  });

  it("handles an insertion at the start and a removal at the end", () => {
    expect(textChange("Body", "---\na: 1\n---\nBody")).toEqual({
      from: 0,
      to: 0,
      insert: "---\na: 1\n---\n",
    });
    expect(textChange("abc", "ab")).toEqual({ from: 2, to: 3, insert: "" });
  });

  it("does not overlap the common start and end when text repeats", () => {
    const change = textChange("aa", "aaa")!;
    const state = EditorState.create({ doc: "aa" }).update({ changes: change }).state;
    expect(state.doc.toString()).toBe("aaa");
  });

  it("is one undo step in the editor", () => {
    let state = EditorState.create({ doc: "x\n", extensions: [history()] });
    state = state.update({ changes: textChange("x\n", "---\na: 1\n---\nx\n")! }).state;
    expect(state.doc.toString()).toBe("---\na: 1\n---\nx\n");
    undo({ state, dispatch: (tr) => (state = tr.state) });
    expect(state.doc.toString()).toBe("x\n");
  });
});

describe("dispatchText", () => {
  it("changes a destroyed view, whose listeners do not run, and tells the caller", () => {
    const listener = vi.fn();
    const view = new EditorView({ doc: "a", extensions: [EditorView.updateListener.of(listener)] });
    view.destroy();
    const unheard = vi.fn();
    dispatchText(view, "ab", unheard);
    expect(view.state.doc.toString()).toBe("ab");
    expect(listener).not.toHaveBeenCalled();
    expect(unheard).toHaveBeenCalledWith("ab");
  });
});

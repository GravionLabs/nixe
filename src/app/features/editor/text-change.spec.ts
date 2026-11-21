// @vitest-environment jsdom
import { history, undo } from "@codemirror/commands";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";

import { textChange } from "./text-change";

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
    const view = new EditorView({
      state: EditorState.create({ doc: "x\n", extensions: [history()] }),
    });
    view.dispatch({ changes: textChange("x\n", "---\na: 1\n---\nx\n")! });
    expect(view.state.doc.toString()).toBe("---\na: 1\n---\nx\n");
    undo(view);
    expect(view.state.doc.toString()).toBe("x\n");
  });
});

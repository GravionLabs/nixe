// @vitest-environment jsdom
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";

import { editorExtensions } from "./editor-spike.component";

function create(size: number, doc = "# Title\n\n- [ ] task\n\n**bold** line") {
  const theme = new Compartment();
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      extensions: editorExtensions(theme, size),
    }),
  });
  return { view, theme, parent };
}

describe("editorExtensions", () => {
  it("draws its own caret and selection layers", () => {
    const { view } = create(14);
    expect(view.dom.querySelector(".cm-cursorLayer")).not.toBeNull();
    expect(view.dom.querySelector(".cm-selectionLayer")).not.toBeNull();
  });

  it("highlights markdown syntax with classes", () => {
    const { view } = create(14);
    expect(view.dom.querySelector(".cm-line [class*='ͼ']")).not.toBeNull();
  });

  it("puts the theme compartment into the state", () => {
    const { view, theme } = create(14);
    expect(theme.get(view.state)).toBeDefined();
  });

  it("reconfiguring the compartment changes the theme", () => {
    const { view, theme } = create(14);
    const before = view.dom.className;
    view.dispatch({
      effects: theme.reconfigure(
        EditorView.theme({ "&": { fontSize: "20px" } }),
      ),
    });
    expect(view.dom.className).not.toBe(before);
  });

  it("keeps the live preview decorations: checkbox widget and hidden bold markers", () => {
    const { view } = create(14);
    expect(view.dom.querySelector("input.cm-task-box")).not.toBeNull();
    expect(view.dom.textContent).not.toContain("**");
  });
});

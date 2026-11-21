// @vitest-environment jsdom
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vitest";

import { livePreview } from "./live-preview";

const DOC = [
  "# Title",
  "",
  "Some **bold** text",
  "",
  "| a | b |",
  "| - | - |",
  "| 1 | 2 |",
  "",
  "```mermaid",
  "graph TD",
  "```",
  "",
  "- [ ] task",
  "- item",
].join("\n");

let view: EditorView | undefined;

function mount(doc: string, cursor: number): EditorView {
  const parent = document.createElement("div");
  document.body.append(parent);
  view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      selection: { anchor: cursor },
      extensions: livePreview({
        render: (el, source, kind) => {
          el.textContent = `rendered ${kind}: ${source.split("\n")[0]}`;
        },
      }),
    }),
  });
  return view;
}

const posOf = (needle: string) => DOC.indexOf(needle);

afterEach(() => {
  view?.destroy();
  view = undefined;
  document.body.innerHTML = "";
});

describe("livePreview", () => {
  it("renders table and diagram as widgets while the cursor is elsewhere", () => {
    const v = mount(DOC, 0);
    const widgets = [...v.dom.querySelectorAll(".cm-live-block")].map((w) => w.textContent);
    expect(widgets).toEqual(["rendered table: | a | b |", "rendered mermaid: ```mermaid"]);
    expect(v.dom.textContent).not.toContain("| 1 | 2 |");
  });

  it("shows the source of the block that holds the cursor", () => {
    const v = mount(DOC, posOf("| 1 | 2 |") + 2);
    const widgets = [...v.dom.querySelectorAll(".cm-live-block")].map((w) => w.textContent);
    expect(widgets).toEqual(["rendered mermaid: ```mermaid"]);
    expect(v.dom.textContent).toContain("| 1 | 2 |");
  });

  it("renders the block again when the cursor leaves it, and keeps the text", () => {
    const v = mount(DOC, posOf("graph TD") + 2);
    expect(v.dom.querySelectorAll(".cm-live-mermaid").length).toBe(0);
    v.dispatch({ selection: { anchor: 0 } });
    expect(v.dom.querySelectorAll(".cm-live-mermaid").length).toBe(1);
    expect(v.state.doc.toString()).toBe(DOC);
  });

  it("hides inline syntax outside the cursor's paragraph only", () => {
    const v = mount(DOC, posOf("Some"));
    expect(v.dom.textContent).toContain("**bold**");
    expect(v.dom.textContent).not.toContain("# Title");
    v.dispatch({ selection: { anchor: 0 } });
    expect(v.dom.textContent).toContain("# Title");
    expect(v.dom.textContent).not.toContain("**bold**");
  });

  it("draws list markers as bullets and tasks as a checkbox", () => {
    const v = mount(DOC, 0);
    expect(v.dom.querySelector(".cm-live-bullet")).not.toBeNull();
    const box = v.dom.querySelector<HTMLInputElement>("input.cm-live-task");
    expect(box?.checked).toBe(false);
  });

  it("toggles the task from the checkbox", () => {
    const v = mount(DOC, 0);
    const box = v.dom.querySelector<HTMLElement>("input.cm-live-task")!;
    box.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    expect(v.state.doc.toString()).toContain("- [x] task");
  });

  it("is not drawn without the extension", () => {
    const parent = document.createElement("div");
    document.body.append(parent);
    view = new EditorView({ parent, state: EditorState.create({ doc: DOC }) });
    expect(view.dom.querySelectorAll(".cm-live-block").length).toBe(0);
    expect(view.dom.textContent).toContain("**bold**");
  });
});

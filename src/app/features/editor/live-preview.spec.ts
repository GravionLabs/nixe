// @vitest-environment jsdom
import { EditorState } from "@codemirror/state";
import { cursorCharRight } from "@codemirror/commands";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vitest";

import type { PropertiesActions, PropertiesHandle } from "./live-preview";
import { livePreview } from "./live-preview";
import type { PropertiesDisplay } from "../../core/settings/settings-core";

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
    expect(widgets).toEqual([
      "rendered table: arendered table: brendered table: 1rendered table: 2",
      "rendered mermaid: ```mermaid",
    ]);
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

  it("puts the cursor into a mermaid block on a click", () => {
    const v = mount(DOC, 0);
    v.dom
      .querySelector<HTMLElement>(".cm-live-mermaid")!
      .dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
    expect(v.state.selection.main.head).toBe(posOf("```mermaid") + "```mermaid".length);
    expect(v.dom.querySelector(".cm-live-mermaid")).toBeNull();
  });

  it("leaves a click on a link inside a widget alone", () => {
    const v = mount(DOC, 0);
    const widget = v.dom.querySelector<HTMLElement>(".cm-live-mermaid")!;
    widget.innerHTML = '<a href="https://example.com">x</a>';
    const ev = new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 });
    widget.querySelector("a")!.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
    expect(v.state.selection.main.head).toBe(0);
    expect(v.dom.querySelector(".cm-live-mermaid")).not.toBeNull();
  });

  it("is not drawn without the extension", () => {
    const parent = document.createElement("div");
    document.body.append(parent);
    view = new EditorView({ parent, state: EditorState.create({ doc: DOC }) });
    expect(view.dom.querySelectorAll(".cm-live-block").length).toBe(0);
    expect(view.dom.textContent).toContain("**bold**");
  });

  describe("frontmatter", () => {
    const FM = "---\ntitle: Hi\ntags:\n  - a\n---\nBody text";

    function mountFm(doc: string, cursor: number, display: PropertiesDisplay = "folded") {
      const mounted: { el: HTMLElement; source: string; actions: PropertiesActions }[] = [];
      const updates: string[] = [];
      let destroyed = 0;
      const parent = document.createElement("div");
      document.body.append(parent);
      view = new EditorView({
        parent,
        state: EditorState.create({
          doc,
          selection: { anchor: cursor },
          extensions: livePreview({
            render: () => undefined,
            propertiesDisplay: () => display,
            mountProperties: (el, source, actions): PropertiesHandle => {
              mounted.push({ el, source, actions });
              el.textContent = `properties ${source.split("\n")[1]}`;
              return {
                update: (text) => updates.push(text),
                destroy: () => destroyed++,
              };
            },
          }),
        }),
      });
      return { v: view, mounted, updates, destroyed: () => destroyed };
    }

    it("draws the frontmatter as the properties block instead of the YAML", () => {
      const { v, mounted } = mountFm(FM, 0);
      expect(v.dom.querySelectorAll(".cm-live-properties").length).toBe(1);
      expect(mounted[0].source).toBe("---\ntitle: Hi\ntags:\n  - a\n---");
      expect(v.dom.textContent).not.toContain("tags:");
      expect(v.dom.textContent).toContain("Body text");
    });

    it("shows the YAML, smaller, while the cursor is in the frontmatter", () => {
      const { v } = mountFm(FM, FM.indexOf("title"));
      expect(v.dom.querySelector(".cm-live-properties")).toBeNull();
      expect(v.dom.querySelectorAll(".cm-live-frontmatter").length).toBe(5);
      expect(v.dom.textContent).toContain("title: Hi");
    });

    it("keeps the block when the cursor is at the start of the note and enters it on a move", () => {
      const { v } = mountFm(FM, 0);
      expect(v.dom.querySelector(".cm-live-properties")).not.toBeNull();
      v.dispatch({ selection: { anchor: FM.indexOf("Body") } });
      expect(v.dom.querySelector(".cm-live-properties")).not.toBeNull();
      v.dispatch({ selection: { anchor: 3 } });
      expect(v.dom.querySelector(".cm-live-properties")).toBeNull();
    });

    it("shows the YAML when the cursor moves on from line 1", () => {
      const { v } = mountFm(FM, 0);
      cursorCharRight(v);
      expect(v.dom.querySelector(".cm-live-properties")).toBeNull();
      expect(v.dom.textContent).toContain("title: Hi");
    });

    it("replaces the frontmatter with the edited text and keeps the body", () => {
      const { v, mounted } = mountFm(FM, 0);
      mounted[0].actions.edit("---\ntitle: New\n---");
      expect(v.state.doc.toString()).toBe("---\ntitle: New\n---\nBody text");
    });

    it("puts the cursor into the frontmatter on Edit as source", () => {
      const { v, mounted } = mountFm(FM, 0);
      mounted[0].actions.showSource();
      expect(v.state.selection.main.head).toBe(FM.indexOf("\n", 4));
      expect(v.dom.querySelector(".cm-live-properties")).toBeNull();
      expect(v.dom.textContent).toContain("title: Hi");
    });

    it("removes the block with its widget when the cursor enters the frontmatter", () => {
      const { v, mounted, destroyed } = mountFm(FM, FM.indexOf("Body"));
      expect(mounted.length).toBe(1);
      v.dispatch({ selection: { anchor: 3 } });
      expect(destroyed()).toBe(1);
      v.dispatch({ selection: { anchor: v.state.doc.length } });
      expect(mounted.length).toBe(2);
    });

    it("updates the block in place when the frontmatter text changes under it", () => {
      const { v, mounted, updates } = mountFm(FM, FM.indexOf("Body"));
      v.dispatch({ changes: { from: FM.indexOf("Hi"), to: FM.indexOf("Hi") + 2, insert: "Yo" } });
      expect(mounted.length).toBe(1);
      expect(updates).toEqual(["---\ntitle: Yo\ntags:\n  - a\n---"]);
    });

    it("draws nothing for hidden properties", () => {
      const { v, mounted } = mountFm(FM, FM.indexOf("Body"), "hidden");
      expect(mounted.length).toBe(0);
      expect(v.dom.textContent).not.toContain("title");
      expect(v.dom.textContent).toContain("Body text");
    });

    it("shows the warning and the YAML of an invalid frontmatter", () => {
      const bad = "---\ntitle: [unclosed\n---\nBody";
      const { v, mounted } = mountFm(bad, bad.indexOf("Body"));
      expect(mounted.length).toBe(0);
      expect(v.dom.querySelector(".cm-live-frontmatter-warning")?.textContent).toContain(
        "Invalid frontmatter",
      );
      expect(v.dom.textContent).toContain("title: [unclosed");
    });

    it("shows no warning for an invalid frontmatter when the properties are hidden", () => {
      const bad = "---\ntitle: [unclosed\n---\nBody";
      const { v } = mountFm(bad, bad.indexOf("Body"), "hidden");
      expect(v.dom.querySelector(".cm-live-frontmatter-warning")).toBeNull();
    });

    it("keeps the YAML as source without a properties hook", () => {
      const parent = document.createElement("div");
      document.body.append(parent);
      view = new EditorView({
        parent,
        state: EditorState.create({
          doc: FM,
          selection: { anchor: FM.indexOf("Body") },
          extensions: livePreview({ render: () => undefined }),
        }),
      });
      expect(view.dom.textContent).toContain("title: Hi");
    });
  });
});

// @vitest-environment jsdom
import { undo, history } from "@codemirror/commands";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vitest";

import { livePreview } from "./live-preview";

const TABLE = ["| a | b |", "| --- | --- |", "| 1 | 2 |"].join("\n");
const DOC = `intro\n\n${TABLE}\n\noutro`;

let view: EditorView | undefined;

function mount(doc = DOC): EditorView {
  const parent = document.createElement("div");
  document.body.append(parent);
  view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      selection: { anchor: 0 },
      extensions: [
        history(),
        livePreview({
          render: (el, source) => {
            el.innerHTML = source.includes("**")
              ? `<p>${source.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")}</p>`
              : `<p>${source}</p>`;
          },
        }),
      ],
    }),
  });
  return view;
}

afterEach(() => {
  view?.destroy();
  view = undefined;
  document.body.innerHTML = "";
});

const cells = (v: EditorView) => [
  ...v.dom.querySelectorAll<HTMLElement>(".cm-live-table th, .cm-live-table td"),
];

function type(td: HTMLElement, text: string): void {
  td.focus();
  td.textContent = text;
  td.dispatchEvent(new Event("input", { bubbles: true }));
}

function key(td: HTMLElement, k: string, shiftKey = false): KeyboardEvent {
  const ev = new KeyboardEvent("keydown", { key: k, shiftKey, bubbles: true, cancelable: true });
  td.dispatchEvent(ev);
  return ev;
}

describe("table widget", () => {
  it("draws every cell as an editable field", () => {
    const v = mount();
    expect(cells(v).map((c) => c.textContent)).toEqual(["a", "b", "1", "2"]);
    expect(cells(v).every((c) => c.getAttribute("contenteditable") === "plaintext-only")).toBe(
      true,
    );
  });

  it("does not rewrite a table that is not touched", () => {
    const doc = "intro\n\n| a|b |\n|-|-|\n| 1 | 2 |";
    const v = mount(doc);
    cells(v)[2].focus();
    cells(v)[2].blur();
    expect(v.state.doc.toString()).toBe(doc);
  });

  it("types into a cell and writes the aligned Markdown", () => {
    const v = mount();
    type(cells(v)[2], "longer");
    expect(v.state.doc.toString()).toBe(
      "intro\n\n| a      | b   |\n| ------ | --- |\n| longer | 2   |\n\noutro",
    );
    // The field being typed in is kept, the others follow the new text.
    expect(cells(v)).toHaveLength(4);
  });

  it("writes a pipe typed into a cell escaped", () => {
    const v = mount();
    type(cells(v)[3], "x|y");
    expect(v.state.doc.toString()).toContain("| x\\|y |");
  });

  it("keeps inline Markdown and draws it when the cell loses the cursor", () => {
    const v = mount();
    const td = cells(v)[2];
    type(td, "**bold**");
    expect(v.state.doc.toString()).toContain("| **bold** |");
    expect(td.textContent).toBe("**bold**");
    td.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    expect(td.querySelector("strong")?.textContent).toBe("bold");
  });

  it("is one undo step per edit", () => {
    const v = mount();
    type(cells(v)[2], "z");
    expect(v.state.doc.toString()).toContain("| z ");
    undo(v);
    expect(v.state.doc.toString()).toBe(DOC);
  });

  it("moves with Tab and Shift+Tab, Enter goes down", () => {
    const v = mount();
    const focus = () => (document.activeElement as HTMLElement).textContent;
    cells(v)[0].focus();
    expect(key(cells(v)[0], "Tab").defaultPrevented).toBe(true);
    expect(focus()).toBe("b");
    key(cells(v)[1], "Tab");
    expect(focus()).toBe("1");
    key(cells(v)[2], "Tab", true);
    expect(focus()).toBe("b");
    key(cells(v)[1], "Enter");
    expect(focus()).toBe("2");
  });

  it("adds a row with Tab in the last cell and focuses its first cell", () => {
    const v = mount();
    cells(v)[3].focus();
    key(cells(v)[3], "Tab");
    expect(v.state.doc.toString()).toContain("| 1   | 2   |\n|     |     |");
    const fields = cells(v);
    expect(fields).toHaveLength(6);
    expect(document.activeElement).toBe(fields[4]);
  });

  it("leaves the table with Escape to the line after it", () => {
    const v = mount();
    cells(v)[0].focus();
    key(cells(v)[0], "Escape");
    const after = v.state.doc.toString().indexOf("outro") - 1;
    expect(v.state.selection.main.head).toBe(after);
    expect(v.dom.querySelector(".cm-live-table")).not.toBeNull();
  });

  describe("context menu", () => {
    function menu(v: EditorView, cell: number): HTMLElement {
      const ev = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
      cells(v)[cell].dispatchEvent(ev);
      expect(ev.defaultPrevented).toBe(true);
      return v.dom.querySelector<HTMLElement>(".cm-live-table-menu")!;
    }
    const item = (m: HTMLElement, label: string) =>
      [...m.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === label)!;

    it("lists the actions", () => {
      const m = menu(mount(), 2);
      expect([...m.querySelectorAll("button")].map((b) => b.textContent)).toEqual([
        "Add row above",
        "Add row below",
        "Add column left",
        "Add column right",
        "Delete row",
        "Delete column",
        "Align left",
        "Align centre",
        "Align right",
        "Edit as source",
      ]);
    });

    it("adds a row above and below", () => {
      const v = mount();
      item(menu(v, 2), "Add row above").click();
      expect(v.state.doc.toString()).toContain("| --- | --- |\n|     |     |\n| 1   | 2   |");
      item(menu(v, 4), "Add row below").click();
      expect(v.state.doc.toString()).toContain("| 1   | 2   |\n|     |     |");
      expect(v.dom.querySelector(".cm-live-table-menu")).toBeNull();
    });

    it("adds columns left and right", () => {
      const v = mount();
      item(menu(v, 0), "Add column left").click();
      expect(v.state.doc.toString()).toContain("|     | a   | b   |");
      item(menu(v, 3), "Add column right").click();
      expect(cells(v)).toHaveLength(8);
    });

    it("deletes a row and a column, not the header row", () => {
      const v = mount();
      expect(item(menu(v, 0), "Delete row").disabled).toBe(true);
      expect(
        item(v.dom.querySelector<HTMLElement>(".cm-live-table-menu")!, "Add row above").disabled,
      ).toBe(true);
      item(v.dom.querySelector<HTMLElement>(".cm-live-table-menu")!, "Delete column").click();
      expect(v.state.doc.toString()).toBe("intro\n\n| b   |\n| --- |\n| 2   |\n\noutro");
      item(menu(v, 1), "Delete row").click();
      expect(v.state.doc.toString()).toBe("intro\n\n| b   |\n| --- |\n\noutro");
    });

    it("aligns a column", () => {
      const v = mount();
      item(menu(v, 0), "Align right").click();
      expect(v.state.doc.toString()).toContain("| --: | --- |");
      item(menu(v, 0), "Align centre").click();
      expect(v.state.doc.toString()).toContain("| :-: | --- |");
      item(menu(v, 0), "Align left").click();
      expect(v.state.doc.toString()).toContain("| :-- | --- |");
      expect(cells(v)[0].style.textAlign).toBe("left");
    });

    it("edit as source puts the cursor into the table so its Markdown shows", () => {
      const v = mount();
      item(menu(v, 2), "Edit as source").click();
      expect(v.dom.querySelector(".cm-live-table")).toBeNull();
      expect(v.dom.textContent).toContain("| 1 | 2 |");
      expect(v.state.doc.lineAt(v.state.selection.main.head).text).toBe("| 1 | 2 |");
    });

    it("closes with Escape", () => {
      const v = mount();
      const m = menu(v, 0);
      m.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      expect(v.dom.querySelector(".cm-live-table-menu")).toBeNull();
    });
  });
});

// @vitest-environment jsdom
import { SearchQuery, setSearchQuery } from "@codemirror/search";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";

import { matchCountLabel } from "./editor-extensions";
import { editorBehavior, editorTheme } from "./editor-extensions";

function stateWith(
  doc: string,
  search: string,
  caseSensitive = false,
  regexp = false,
): EditorState {
  const state = EditorState.create({
    doc,
    extensions: editorBehavior({ onSave: () => {}, onBlur: () => {}, onLink: () => {} }),
  });
  return state.update({
    effects: setSearchQuery.of(new SearchQuery({ search, caseSensitive, regexp })),
  }).state;
}

describe("matchCountLabel", () => {
  it("is empty without a query", () => {
    expect(matchCountLabel(stateWith("a b", ""))).toBe("");
  });

  it("counts the matches and the current one", () => {
    expect(matchCountLabel(stateWith("foo Foo foo", "foo"))).toBe("1 / 3");
  });

  it("honours case and regex options", () => {
    expect(matchCountLabel(stateWith("foo Foo foo", "foo", true))).toBe("1 / 2");
    expect(matchCountLabel(stateWith("a1 b22", "\\d+", false, true))).toBe("1 / 2");
  });

  it("says when nothing matches", () => {
    expect(matchCountLabel(stateWith("abc", "x"))).toBe("No matches");
  });
});

describe("wikilink hover", () => {
  function mount(onWikilinkHover: (h: unknown) => void) {
    const parent = document.createElement("div");
    document.body.append(parent);
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: "see [[Note#Head|Alias]] now",
        extensions: editorBehavior({
          onSave: () => {},
          onBlur: () => {},
          onLink: () => {},
          onWikilinkHover,
        }),
      }),
    });
    return view;
  }

  it("reports the wikilink under the pointer with the modifier state", () => {
    const calls: unknown[] = [];
    const view = mount((h) => calls.push(h));
    // jsdom has no layout: place the pointer through the view's own coordinate lookup.
    view.posAtCoords = () => 8;
    view.coordsAtPos = () => ({ left: 10, right: 20, top: 5, bottom: 20 });
    view.contentDOM.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, metaKey: true }));
    expect(calls).toEqual([
      {
        value: "Note#Head|Alias",
        anchor: { left: 10, right: 20, top: 5, bottom: 20 },
        modifier: true,
      },
    ]);
  });

  it("reports null off a wikilink and when the pointer leaves", () => {
    const calls: unknown[] = [];
    const view = mount((h) => calls.push(h));
    view.posAtCoords = () => 1;
    view.contentDOM.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
    view.contentDOM.dispatchEvent(new MouseEvent("mouseleave"));
    expect(calls).toEqual([null, null]);
  });
});

describe("link clicks", () => {
  function mount(plain: boolean) {
    const opened: Array<[string, string, boolean]> = [];
    const parent = document.createElement("div");
    document.body.append(parent);
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: "[[Note]] [t](https://a.b/c) https://d.e plain",
        extensions: editorBehavior({
          onSave: () => {},
          onBlur: () => {},
          onLink: (l, newTab) => opened.push([l.kind, l.target, newTab]),
          opensOnPlainClick: () => plain,
        }),
      }),
    });
    const click = (pos: number, init: MouseEventInit = {}) => {
      view.posAtCoords = () => pos;
      const e = new MouseEvent("mousedown", { bubbles: true, cancelable: true, ...init });
      view.contentDOM.dispatchEvent(e);
      return e.defaultPrevented;
    };
    return { opened, click };
  }

  it("opens every kind with the modifier", () => {
    const { opened, click } = mount(false);
    expect(click(3, { ctrlKey: true })).toBe(true);
    click(14, { metaKey: true });
    click(34, { ctrlKey: true });
    expect(opened).toEqual([
      ["wikilink", "Note", true],
      ["markdown", "https://a.b/c", true],
      ["url", "https://d.e", true],
    ]);
  });

  it("leaves a click without modifier to the editor where it does not open", () => {
    const { opened, click } = mount(false);
    click(14);
    expect(opened).toEqual([]);
  });

  it("opens in the same tab on a plain click where the preview is drawn", () => {
    const { opened, click } = mount(true);
    expect(click(14)).toBe(true);
    expect(opened).toEqual([["markdown", "https://a.b/c", false]]);
  });

  it("does not open from the middle of plain text", () => {
    const { opened, click } = mount(true);
    click(43, { ctrlKey: true });
    expect(opened).toEqual([]);
  });
});

describe("live preview widget styles", () => {
  it("resets the white space the editor's line wrapping inherits", () => {
    const view = new EditorView({
      parent: document.body,
      state: EditorState.create({ doc: "x", extensions: [editorTheme(false, 100)] }),
    });
    const css = [...document.querySelectorAll("style")].map((s) => s.textContent).join("\n");
    const rule = /\.cm-live-block\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(rule).toMatch(/white-space:\s*normal/);
    expect(rule).toMatch(/word-break:\s*normal/);
    expect(rule).toMatch(/overflow-wrap:\s*normal/);
    view.destroy();
  });
});

describe("frontmatter styling", () => {
  function render(doc: string): HTMLElement {
    const parent = document.createElement("div");
    document.body.append(parent);
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc,
        extensions: editorBehavior({ onSave: () => {}, onBlur: () => {}, onLink: () => {} }),
      }),
    });
    // The parser runs in the first slice; make sure the tree is complete before reading.
    view.requestMeasure();
    return view.dom;
  }

  it("draws the frontmatter lines without a heading or syntax class", () => {
    const dom = render("---\ntitle: Note\ntags: [a, b]\n---\n\nBody");
    const lines = [...dom.querySelectorAll(".cm-line")].slice(0, 4);
    expect(lines).toHaveLength(4);
    for (const line of lines) {
      expect(line.querySelector("[class*='cm-md-']")).toBeNull();
    }
  });

  it("keeps a rule after a paragraph in the body a Setext heading", () => {
    const dom = render("---\ntitle: Note\n---\n\nBody text\n---\n");
    expect(dom.querySelector(".cm-md-h2")?.textContent).toContain("Body text");
  });
});

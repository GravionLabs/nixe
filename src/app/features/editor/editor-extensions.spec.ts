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
    extensions: editorBehavior({ onSave: () => {}, onBlur: () => {}, onWikilink: () => {} }),
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
          onWikilink: () => {},
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

describe("live preview widget styles", () => {
  it("resets the white space the editor's line wrapping inherits", () => {
    const view = new EditorView({
      parent: document.body,
      state: EditorState.create({ doc: "x", extensions: [editorTheme(false, 14)] }),
    });
    const css = [...document.querySelectorAll("style")].map((s) => s.textContent).join("\n");
    const rule = /\.cm-live-block\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(rule).toMatch(/white-space:\s*normal/);
    expect(rule).toMatch(/word-break:\s*normal/);
    expect(rule).toMatch(/overflow-wrap:\s*normal/);
    view.destroy();
  });
});

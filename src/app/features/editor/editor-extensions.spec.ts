import { SearchQuery, setSearchQuery } from "@codemirror/search";
import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";

import { matchCountLabel } from "./editor-extensions";
import { editorBehavior } from "./editor-extensions";

function stateWith(doc: string, search: string, caseSensitive = false, regexp = false): EditorState {
  const state = EditorState.create({ doc, extensions: editorBehavior({ onSave: () => {}, onBlur: () => {}, onWikilink: () => {} }) });
  return state.update({ effects: setSearchQuery.of(new SearchQuery({ search, caseSensitive, regexp })) }).state;
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

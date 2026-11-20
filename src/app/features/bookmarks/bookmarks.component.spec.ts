import { describe, expect, it } from "vitest";

import type { Bookmark } from "../../core/bookmarks/bookmarks-core";
import { bookmarkRows } from "./bookmarks.component";

describe("bookmarkRows", () => {
  it("lists notes, headings, searches and groups with depth and kind", () => {
    const items: Bookmark[] = [
      { type: "file", path: "a.md" },
      {
        type: "group",
        title: "G",
        items: [
          { type: "file", path: "b.md", subpath: "#H" },
          { type: "search", query: "q" },
        ],
      },
      { type: "graph" },
    ];
    expect(bookmarkRows(items).map((r) => [r.path.join("."), r.depth, r.kind])).toEqual([
      ["0", 0, "note"],
      ["1", 0, "group"],
      ["1.0", 1, "heading"],
      ["1.1", 1, "search"],
      ["2", 0, "other"],
    ]);
  });
});

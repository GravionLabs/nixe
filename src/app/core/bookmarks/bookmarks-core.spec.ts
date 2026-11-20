import { describe, expect, it } from "vitest";

import {
  Bookmark,
  GroupBookmark,
  addBookmark,
  addGroup,
  contains,
  headingLine,
  itemAt,
  labelOf,
  moveItem,
  parseBookmarks,
  removeAt,
  removeMatching,
  renameGroup,
  renamePath,
  serializeBookmarks,
} from "./bookmarks-core";

const note = (path: string, subpath?: string): Bookmark => ({
  type: "file",
  path,
  ...(subpath ? { subpath } : {}),
});
const titles = (items: Bookmark[]) =>
  items.map((b) =>
    b.type === "group" ? `[${(b as GroupBookmark).items.map(labelOf).join(",")}]` : labelOf(b),
  );

describe("parseBookmarks / serializeBookmarks", () => {
  it("reads Obsidian's format and keeps what it does not know", () => {
    const text = JSON.stringify({
      items: [
        { type: "file", path: "a.md", ctime: 1 },
        {
          type: "group",
          title: "G",
          items: [
            { type: "search", query: "todo" },
            { type: "url", url: "https://x" },
          ],
        },
        { type: "graph", title: "Graph" },
      ],
      other: 3,
    });
    const file = parseBookmarks(text);
    expect(file.items).toHaveLength(3);
    expect(file.extra).toEqual({ other: 3 });
    const back = JSON.parse(serializeBookmarks(file));
    expect(back.other).toBe(3);
    expect(back.items[1].items[1]).toEqual({ type: "url", url: "https://x" });
    expect(back.items[2]).toEqual({ type: "graph", title: "Graph" });
  });

  it("treats missing, damaged and wrongly shaped text as empty and drops broken items", () => {
    for (const bad of [null, "", "nope", "[1]", "null", '{"items":5}'])
      expect(parseBookmarks(bad).items).toEqual([]);
    const file = parseBookmarks(
      '{"items":[{"type":"file"},{"type":"search","query":3},7,{"type":"file","path":"a.md"}]}',
    );
    expect(file.items).toEqual([{ type: "file", path: "a.md" }]);
  });
});

describe("add and remove", () => {
  it("adds a note once, a heading as another bookmark, and a search", () => {
    let items: Bookmark[] = [];
    items = addBookmark(items, { type: "file", path: "a.md" }, 5);
    items = addBookmark(items, { type: "file", path: "a.md" }, 6);
    items = addBookmark(items, { type: "file", path: "a.md", subpath: "#Intro" }, 7);
    items = addBookmark(items, { type: "search", query: "tag:#x" }, 8);
    expect(titles(items)).toEqual(["a", "a #Intro", "tag:#x"]);
    expect(items[0]).toMatchObject({ ctime: 5 });
    expect(contains(items, { type: "search", query: "tag:#x" })).toBe(true);
    expect(contains(items, { type: "file", path: "b.md" })).toBe(false);
  });

  it("removes by position and by value, also inside a group", () => {
    const items: Bookmark[] = [
      note("a.md"),
      { type: "group", title: "G", items: [note("b.md"), note("c.md")] },
    ];
    expect(titles(removeAt(items, [1, 0]))).toEqual(["a", "[c]"]);
    expect(titles(removeMatching(items, { type: "file", path: "c.md" }))).toEqual(["a", "[b]"]);
    expect(removeAt(items, [])).toBe(items);
  });

  it("creates and renames a group", () => {
    let items = addGroup([], "Work", 1);
    items = renameGroup(items, [0], "Home");
    expect(labelOf(items[0]!)).toBe("Home");
    expect(renameGroup(items, [3], "x")).toBe(items);
  });
});

describe("moveItem", () => {
  const abc = (): Bookmark[] => [note("a.md"), note("b.md"), note("c.md")];

  it("reorders in the root, counting the target before the move", () => {
    expect(titles(moveItem(abc(), [0], [], 3))).toEqual(["b", "c", "a"]);
    expect(titles(moveItem(abc(), [2], [], 0))).toEqual(["c", "a", "b"]);
    expect(titles(moveItem(abc(), [0], [], 2))).toEqual(["b", "a", "c"]);
  });

  it("moves into a group and out of it", () => {
    const items: Bookmark[] = [
      note("a.md"),
      { type: "group", title: "G", items: [] },
      note("c.md"),
    ];
    const into = moveItem(items, [0], [1], 0);
    expect(titles(into)).toEqual(["[a]", "c"]);
    expect(titles(moveItem(into, [0, 0], [], 1))).toEqual(["[]", "a", "c"]);
  });

  it("keeps a group out of itself", () => {
    const items: Bookmark[] = [{ type: "group", title: "G", items: [note("a.md")] }];
    expect(moveItem(items, [0], [0], 0)).toBe(items);
    expect(moveItem(items, [5], [], 0)).toBe(items);
  });

  it("moves an item to a group that sits behind it", () => {
    const items: Bookmark[] = [
      note("a.md"),
      note("b.md"),
      { type: "group", title: "G", items: [note("x.md")] },
    ];
    expect(titles(moveItem(items, [0], [2], 1))).toEqual(["b", "[x,a]"]);
  });
});

describe("renamePath", () => {
  it("keeps the bookmark of a renamed note, with its heading, and of a moved folder", () => {
    const items: Bookmark[] = [
      note("a.md", "#Intro"),
      note("dir/b.md"),
      { type: "group", title: "G", items: [note("dir/c.md"), note("other/d.md")] },
      { type: "search", query: "a.md" },
      { type: "folder", path: "dir" },
    ];
    const next = renamePath(items, "dir", "moved");
    expect(itemAt(next, [1])).toMatchObject({ path: "moved/b.md" });
    expect(itemAt(next, [2, 0])).toMatchObject({ path: "moved/c.md" });
    expect(itemAt(next, [2, 1])).toMatchObject({ path: "other/d.md" });
    expect(itemAt(next, [4])).toMatchObject({ path: "moved" });
    const renamed = renamePath(items, "a.md", "z.md");
    expect(itemAt(renamed, [0])).toMatchObject({ path: "z.md", subpath: "#Intro" });
    expect(itemAt(renamed, [3])).toEqual({ type: "search", query: "a.md" });
    expect(renamePath(items, "dir", "dirs")[1]).toMatchObject({ path: "dirs/b.md" });
    expect(renamePath([note("dir2/e.md")], "dir", "x")[0]).toMatchObject({ path: "dir2/e.md" });
  });
});

describe("headingLine", () => {
  const headings = [
    { text: "Intro", line: 1 },
    { text: "Deep Dive", line: 9 },
  ];
  it("finds a heading ignoring case, null for a note, a block or a missing heading", () => {
    expect(headingLine("#deep dive", headings)).toBe(9);
    expect(headingLine(undefined, headings)).toBeNull();
    expect(headingLine("#^block", headings)).toBeNull();
    expect(headingLine("#Gone", headings)).toBeNull();
  });
});

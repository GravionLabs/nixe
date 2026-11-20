import { describe, expect, it } from "vitest";

import { decorate, filterTree, highlightParts, matchesFilter } from "./tree-filter";

describe("decorate", () => {
  it("maps the status to letters and marks the folders on the way", () => {
    const d = decorate(
      [
        { path: "a.md", kind: "modified" },
        { path: "dir/sub/b.md", kind: "added" },
        { path: "dir/c.md", kind: "added", untracked: true },
        { path: "gone.md", kind: "deleted" },
      ],
      "/v",
    );
    expect([...d.files]).toEqual([
      ["/v/a.md", "M"],
      ["/v/dir/sub/b.md", "A"],
      ["/v/dir/c.md", "U"],
    ]);
    expect([...d.folders].sort()).toEqual(["/v/dir", "/v/dir/sub"]);
  });
});

describe("matchesFilter", () => {
  it("ignores case and surrounding blanks; an empty text matches all", () => {
    expect(matchesFilter("Daily Note.md", " daily ")).toBe(true);
    expect(matchesFilter("Daily Note.md", "x")).toBe(false);
    expect(matchesFilter("a", "  ")).toBe(true);
  });
});

describe("highlightParts", () => {
  it("splits a name at every match", () => {
    expect(highlightParts("Banana", "an")).toEqual([
      { text: "B", match: false },
      { text: "an", match: true },
      { text: "an", match: true },
      { text: "a", match: false },
    ]);
    expect(highlightParts("note", "")).toEqual([{ text: "note", match: false }]);
    expect(highlightParts("note", "zz")).toEqual([{ text: "note", match: false }]);
  });
});

describe("filterTree", () => {
  const leaf = (name: string) => ({ name, dirPath: null, children: () => null });
  const dir = (name: string, kids: ReturnType<typeof leaf>[] | null) => ({
    name,
    dirPath: `/v/${name}`,
    children: () => kids,
  });
  it("keeps matches and the folders leading to them, also collapsed ones", () => {
    const inner = dir("inner", [leaf("plan.md"), leaf("other.md")]);
    const tree = [
      dir("work", [inner as never]),
      dir("empty", []),
      leaf("plans.md"),
      leaf("zzz.md"),
      dir("planet", null),
    ];
    expect(filterTree(tree as never[], "plan").map((n) => n.name)).toEqual([
      "work",
      "inner",
      "plan.md",
      "plans.md",
      "planet",
    ]);
  });
});

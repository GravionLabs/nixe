import { describe, expect, it } from "vitest";
import type { DirEntry } from "../file/backend";
import { buildTreeItems, sanitizeTreeSort, sortItems, conflictOriginal, conflictPaths, defaultPage, wikiDisplayName } from "./tree-model";

const dir = (name: string, hasOrder = false): DirEntry => ({ name, path: `/w/${name}`, isDir: true, hasOrder, modified: 0 });
const file = (name: string, modified = 0): DirEntry => ({ name, path: `/w/${name}`, isDir: false, hasOrder: false, modified });

describe("buildTreeItems", () => {
  it("merges ADO page file and sub-page folder", () => {
    const items = buildTreeItems([file("Home.md"), dir("Architektur", true), file("Architektur.md")], true);
    expect(items).toEqual([
      { name: "Home", dirPath: null, filePath: "/w/Home.md", hasOrder: false, modified: 0 },
      { name: "Architektur", dirPath: "/w/Architektur", filePath: "/w/Architektur.md", hasOrder: true, modified: 0 },
    ]);
  });

  it("decodes ADO names only inside wikis", () => {
    expect(buildTreeItems([file("Getting-Started.md")], true)[0].name).toBe("Getting Started");
    expect(buildTreeItems([file("Getting-Started.md")], false)[0].name).toBe("Getting-Started.md");
    expect(wikiDisplayName("Q%2DA-Session")).toBe("Q-A Session");
  });

  it("keeps plain folders expandable without a page", () => {
    expect(buildTreeItems([dir("docs")], false)).toEqual([
      { name: "docs", dirPath: "/w/docs", filePath: null, hasOrder: false, modified: 0 },
    ]);
  });
});

describe("defaultPage", () => {
  it("prefers README, then index/Home, then the first page", () => {
    expect(defaultPage(buildTreeItems([file("a.md"), file("README.md")], false))).toBe("/w/README.md");
    expect(defaultPage(buildTreeItems([file("a.md"), file("Home.md")], true))).toBe("/w/Home.md");
    expect(defaultPage(buildTreeItems([dir("x"), file("b.md")], false))).toBe("/w/b.md");
    expect(defaultPage([])).toBeNull();
  });
});

describe("conflict copies", () => {
  it("finds the original of a copy", () => {
    expect(conflictOriginal("Note (conflict 2026-11-16 mac).md")).toBe("Note.md");
    expect(conflictOriginal("p (conflict 2026-11-16 my pc).png")).toBe("p.png");
    expect(conflictOriginal("README (conflict 2026-11-16 mac)")).toBe("README");
    expect(conflictOriginal("Note.md")).toBeNull();
    expect(conflictOriginal("Note (conflict).md")).toBeNull();
  });

  it("marks a copy and the original next to it", () => {
    const marked = conflictPaths([
      "/w/a.md",
      "/w/a (conflict 2026-11-16 mac).md",
      "/w/b.md",
      "/w/d/c.md",
      "/w/d/c (conflict 2026-11-16 mac).md",
      "/w/e (conflict 2026-11-16 mac).md",
    ]);
    expect([...marked].sort()).toEqual([
      "/w/a (conflict 2026-11-16 mac).md",
      "/w/a.md",
      "/w/d/c (conflict 2026-11-16 mac).md",
      "/w/d/c.md",
    ]);
  });
});

describe("sortItems", () => {
  const items = buildTreeItems(
    [file("b.md", 20), dir("Zed"), file("a.md", 30), dir("Alpha"), file("c.md", 10)],
    false,
  ).map((i, n) => (i.dirPath ? { ...i, modified: 100 + n } : i));
  const names = (sort: Parameters<typeof sortItems>[1]) => sortItems(items, sort).map((i) => i.name);

  it("keeps the given order for name ascending", () => {
    expect(sortItems(items, "name-asc")).toBe(items);
  });

  it("sorts by name descending, folders first", () => {
    expect(names("name-desc")).toEqual(["Zed", "Alpha", "c.md", "b.md", "a.md"]);
  });

  it("sorts by modified time, folders first", () => {
    expect(names("modified-desc")).toEqual(["Alpha", "Zed", "a.md", "b.md", "c.md"]);
    expect(names("modified-asc")).toEqual(["Zed", "Alpha", "c.md", "b.md", "a.md"]);
  });

  it("does not change its input", () => {
    const before = items.map((i) => i.name);
    sortItems(items, "modified-asc");
    expect(items.map((i) => i.name)).toEqual(before);
  });
});

describe("sanitizeTreeSort", () => {
  it("falls back to name ascending", () => {
    expect(sanitizeTreeSort("modified-asc")).toBe("modified-asc");
    expect(sanitizeTreeSort("size")).toBe("name-asc");
    expect(sanitizeTreeSort(undefined)).toBe("name-asc");
  });
});

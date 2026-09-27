import { describe, expect, it } from "vitest";
import type { DirEntry } from "../file/backend";
import { buildTreeItems, defaultPage, wikiDisplayName } from "./tree-model";

const dir = (name: string, hasOrder = false): DirEntry => ({ name, path: `/w/${name}`, isDir: true, hasOrder });
const file = (name: string): DirEntry => ({ name, path: `/w/${name}`, isDir: false, hasOrder: false });

describe("buildTreeItems", () => {
  it("merges ADO page file and sub-page folder", () => {
    const items = buildTreeItems([file("Home.md"), dir("Architektur", true), file("Architektur.md")], true);
    expect(items).toEqual([
      { name: "Home", dirPath: null, filePath: "/w/Home.md", hasOrder: false },
      { name: "Architektur", dirPath: "/w/Architektur", filePath: "/w/Architektur.md", hasOrder: true },
    ]);
  });

  it("decodes ADO names only inside wikis", () => {
    expect(buildTreeItems([file("Getting-Started.md")], true)[0].name).toBe("Getting Started");
    expect(buildTreeItems([file("Getting-Started.md")], false)[0].name).toBe("Getting-Started.md");
    expect(wikiDisplayName("Q%2DA-Session")).toBe("Q-A Session");
  });

  it("keeps plain folders expandable without a page", () => {
    expect(buildTreeItems([dir("docs")], false)).toEqual([
      { name: "docs", dirPath: "/w/docs", filePath: null, hasOrder: false },
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

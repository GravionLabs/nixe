import { describe, expect, it } from "vitest";

import { noteFromLinkTarget, planMove, remapPath, renamedName, topLevelPaths, uniqueName } from "./file-ops";

describe("uniqueName", () => {
  it("uses the plain name when it is free", () => {
    expect(uniqueName(["a.md"], "Untitled", ".md")).toBe("Untitled.md");
  });

  it("numbers a taken name, ignoring case", () => {
    expect(uniqueName(["untitled.md"], "Untitled", ".md")).toBe("Untitled 1.md");
    expect(uniqueName(["Untitled.md", "Untitled 1.md"], "Untitled", ".md")).toBe("Untitled 2.md");
    expect(uniqueName(["Untitled"], "Untitled", "")).toBe("Untitled 1");
  });
});

describe("noteFromLinkTarget", () => {
  it("appends .md and keeps a folder part", () => {
    expect(noteFromLinkTarget("Foo")).toEqual({ folder: "", name: "Foo.md" });
    expect(noteFromLinkTarget("a/b/Foo")).toEqual({ folder: "a/b", name: "Foo.md" });
    expect(noteFromLinkTarget("Foo.md")).toEqual({ folder: "", name: "Foo.md" });
  });

  it("ignores a heading or block part", () => {
    expect(noteFromLinkTarget("Foo#Bar")).toEqual({ folder: "", name: "Foo.md" });
    expect(noteFromLinkTarget("a/Foo#^abc")).toEqual({ folder: "a", name: "Foo.md" });
    expect(noteFromLinkTarget("#Heading")).toBeNull();
  });

  it("drops invalid characters and path escapes", () => {
    expect(noteFromLinkTarget("../../etc/Foo?")).toEqual({ folder: "etc", name: "Foo.md" });
    expect(noteFromLinkTarget("Foo|bar")).toEqual({ folder: "", name: "Foobar.md" });
    expect(noteFromLinkTarget("..")).toBeNull();
    expect(noteFromLinkTarget("  ")).toBeNull();
  });
});

describe("renamedName", () => {
  it("keeps the extension of a note when none is typed", () => {
    expect(renamedName("a.md", "b")).toBe("b.md");
    expect(renamedName("a.md", "b.txt")).toBe("b.txt");
    expect(renamedName("folder", "other")).toBe("other");
  });

  it("refuses empty names and separators", () => {
    expect(renamedName("a.md", "  ")).toBeNull();
    expect(renamedName("a.md", "x/y")).toBeNull();
    expect(renamedName("a.md", "..")).toBeNull();
  });
});

describe("remapPath", () => {
  it("moves the path itself and what lies below it", () => {
    expect(remapPath("/v/a", "/v/a", "/v/b")).toBe("/v/b");
    expect(remapPath("/v/a/x.md", "/v/a", "/v/b")).toBe("/v/b/x.md");
    expect(remapPath("/v/ab/x.md", "/v/a", "/v/b")).toBe("/v/ab/x.md");
  });
});

describe("topLevelPaths and planMove", () => {
  it("drops entries inside another selected folder", () => {
    expect(topLevelPaths(["/v/a", "/v/a/x.md", "/v/ab.md", "/v/a"])).toEqual(["/v/a", "/v/ab.md"]);
  });

  it("plans the moves into a folder and leaves entries already there", () => {
    expect(planMove(["/v/a.md", "/v/d/b.md", "/v/e"], "/v/d")).toEqual([
      { from: "/v/a.md", to: "/v/d/a.md" },
      { from: "/v/e", to: "/v/d/e" },
    ]);
  });

  it("refuses a folder into itself or below itself", () => {
    expect(() => planMove(["/v/a"], "/v/a")).toThrow(/into itself/);
    expect(() => planMove(["/v/a"], "/v/a/b")).toThrow(/into itself/);
  });

  it("refuses two entries with the same name", () => {
    expect(() => planMove(["/v/x/n.md", "/v/y/N.md"], "/v/d")).toThrow(/more than one/);
  });
});

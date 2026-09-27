import { describe, expect, it } from "vitest";
import { classifyHref, localCandidates, nameVariants, resolveLocalLink } from "./link-resolver";
import { dirname, joinPath } from "./paths";

describe("classifyHref", () => {
  it("classifies anchors, external and local links", () => {
    expect(classifyHref("#abschnitt-2")).toEqual({ kind: "anchor", anchor: "abschnitt-2" });
    expect(classifyHref("https://example.com")).toEqual({ kind: "external", url: "https://example.com" });
    expect(classifyHref("mailto:a@b.de")).toEqual({ kind: "external", url: "mailto:a@b.de" });
    expect(classifyHref("./other.md#sec")).toEqual({ kind: "local", path: "./other.md", anchor: "sec" });
    expect(classifyHref("/Parent/Child-Page")).toEqual({ kind: "local", path: "/Parent/Child-Page", anchor: null });
    expect(classifyHref("C:/docs/a.md")).toEqual({ kind: "local", path: "C:/docs/a.md", anchor: null });
  });

  it("ignores unsafe or empty links", () => {
    expect(classifyHref("javascript:alert(1)")).toEqual({ kind: "none" });
    expect(classifyHref("")).toEqual({ kind: "none" });
    expect(classifyHref(null)).toEqual({ kind: "none" });
  });

  it("handles file:// URLs", () => {
    expect(classifyHref("file:///Users/me/a%20b.md")).toEqual({ kind: "local", path: "/Users/me/a b.md", anchor: null });
    expect(classifyHref("file:///C:/x.md")).toEqual({ kind: "local", path: "C:/x.md", anchor: null });
  });
});

describe("nameVariants (Azure DevOps encoding)", () => {
  it("maps hyphens to spaces and %2D to hyphens", () => {
    expect(nameVariants("Getting-Started")).toEqual(["Getting-Started", "Getting Started"]);
    expect(nameVariants("Q%2DA-Session")).toEqual(["Q-A-Session", "Q-A Session", "Q%2DA-Session"]);
    expect(nameVariants("plain%20name")).toEqual(["plain name", "plain%20name"]);
  });
});

describe("resolveLocalLink", () => {
  const ctx = { currentFile: "/wiki/Architektur/Overview.md", wikiRoot: "/wiki" };

  it("builds candidates in priority order", () => {
    expect(localCandidates("../Home", ctx)).toEqual(["/wiki/Home.md", "/wiki/Home"]);
    expect(localCandidates("/Architektur/Data-Flow", ctx)).toEqual([
      "/wiki/Architektur/Data-Flow.md",
      "/wiki/Architektur/Data-Flow",
      "/wiki/Architektur/Data Flow.md",
      "/wiki/Architektur/Data Flow",
      "/Architektur/Data-Flow.md",
      "/Architektur/Data-Flow",
      "/Architektur/Data Flow.md",
      "/Architektur/Data Flow",
    ]);
  });

  it("resolves the first existing candidate", async () => {
    const files = new Set(["/wiki/Architektur/Data Flow.md", "/wiki/img/logo.png", "/wiki/Q%2DA.md"]);
    const exists = async (p: string) => files.has(p);
    expect(await resolveLocalLink("/Architektur/Data-Flow", { ...ctx, exists })).toBe("/wiki/Architektur/Data Flow.md");
    expect(await resolveLocalLink("../img/logo.png", { ...ctx, exists })).toBe("/wiki/img/logo.png");
    expect(await resolveLocalLink("/Q%2DA", { ...ctx, exists })).toBe("/wiki/Q%2DA.md");
    expect(await resolveLocalLink("Missing", { ...ctx, exists })).toBeNull();
  });

  it("falls back to real absolute paths", async () => {
    const exists = async (p: string) => p === "/Users/me/notes.md";
    expect(await resolveLocalLink("/Users/me/notes.md", { ...ctx, exists })).toBe("/Users/me/notes.md");
  });
});

describe("paths", () => {
  it("normalizes POSIX and Windows paths", () => {
    expect(joinPath("/a/b", "../c", "./d.md")).toBe("/a/c/d.md");
    expect(joinPath("C:\\docs\\wiki", "..\\x.md")).toBe("C:/docs/x.md");
    expect(joinPath("/", "..", "a")).toBe("/a");
    expect(dirname("C:/x.md")).toBe("C:/");
    expect(dirname("/x.md")).toBe("/");
  });
});

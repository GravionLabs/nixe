import { describe, expect, it } from "vitest";

import { changed, enabledSnippets, overridesCss, sanitizeAccent, sanitizeFont, sanitizeNames } from "./appearance-core";

const file = (name: string, css = "", modified = 1) => ({ name, css, modified });

describe("sanitizeAccent", () => {
  it("accepts #rgb and #rrggbb and normalises them", () => {
    expect(sanitizeAccent("#4F46E5")).toBe("#4f46e5");
    expect(sanitizeAccent(" #abc ")).toBe("#aabbcc");
  });

  it("rejects everything else", () => {
    for (const v of ["red", "#12", "#12345g", "#4f46e5;}", "rgb(1,2,3)", 5, null, undefined]) expect(sanitizeAccent(v)).toBe("");
  });
});

describe("sanitizeFont", () => {
  it("keeps a font list", () => {
    expect(sanitizeFont('  "Inter", sans-serif ')).toBe('"Inter", sans-serif');
  });

  it("drops what could open a new rule or declaration", () => {
    for (const v of ["a;color:red", "a}b{", "a/*", "url(x)", "a\\", "<b>", "x".repeat(300), "", 3]) expect(sanitizeFont(v)).toBe("");
  });
});

describe("sanitizeNames", () => {
  it("keeps unique non-empty strings", () => {
    expect(sanitizeNames(["a", "a", "", 3, "b"])).toEqual(["a", "b"]);
    expect(sanitizeNames("a")).toEqual([]);
  });
});

describe("overridesCss", () => {
  it("is empty without settings", () => {
    expect(overridesCss("", "", "")).toBe("");
  });

  it("sets the accent and its shades and the fonts", () => {
    const css = overridesCss("#112233", "Inter", "Fira Code, monospace");
    expect(css).toContain("--nixe-accent:#112233");
    expect(css).toContain("--h-primary-600:#112233");
    expect(css).toContain("--nixe-font-text:Inter");
    expect(css).toContain("--nixe-font-mono:Fira Code, monospace");
  });

  it("ignores unsafe values", () => {
    expect(overridesCss("red", "a;b", "}")).toBe("");
  });
});

describe("enabledSnippets", () => {
  it("keeps the enabled files in file order and ignores missing names", () => {
    const files = [file("a"), file("b"), file("c")];
    expect(enabledSnippets(files, ["c", "a", "gone"]).map((f) => f.name)).toEqual(["a", "c"]);
  });
});

describe("changed", () => {
  it("detects a different list, time or content", () => {
    expect(changed([file("a")], [file("a")])).toBe(false);
    expect(changed([file("a")], [file("a"), file("b")])).toBe(true);
    expect(changed([file("a")], [file("a", "", 2)])).toBe(true);
    expect(changed([file("a", "x")], [file("a", "y")])).toBe(true);
    expect(changed([file("a")], [file("b")])).toBe(true);
  });
});

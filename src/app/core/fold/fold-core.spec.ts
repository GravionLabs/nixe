import { describe, expect, it } from "vitest";

import { foldRanges, hiddenBlocks, normalizeLines, parseFoldState, serializeFoldState } from "./fold-core";

describe("foldRanges", () => {
  it("folds the frontmatter", () => {
    const r = foldRanges("---\ntitle: A\ntags: [x]\n---\n\nBody");
    expect(r).toEqual([{ line: 1, endLine: 4, kind: "frontmatter" }]);
  });

  it("has no frontmatter fold when it is empty or unclosed", () => {
    expect(foldRanges("---\n---\ntext")).toEqual([]);
    expect(foldRanges("---\ntitle: A\ntext")).toEqual([]);
  });

  it("folds a heading down to the next heading of the same or a higher level", () => {
    const r = foldRanges("# A\ntext\n## B\nb\n## C\nc\n# D\nd");
    expect(r.filter((x) => x.kind === "heading")).toEqual([
      { line: 1, endLine: 6, kind: "heading" },
      { line: 3, endLine: 4, kind: "heading" },
      { line: 5, endLine: 6, kind: "heading" },
      { line: 7, endLine: 8, kind: "heading" },
    ]);
  });

  it("leaves trailing blank lines visible and skips empty sections", () => {
    const r = foldRanges("# A\ntext\n\n\n# B\n# C\nx");
    expect(r).toEqual([
      { line: 1, endLine: 2, kind: "heading" },
      { line: 6, endLine: 7, kind: "heading" },
    ]);
  });

  it("ignores headings inside code fences", () => {
    const r = foldRanges("# A\n```\n# not\n```\ntext");
    expect(r).toEqual([{ line: 1, endLine: 5, kind: "heading" }]);
  });

  it("folds list items with their deeper lines and nested items", () => {
    const r = foldRanges("- a\n  - b\n    detail\n  - c\n- d\n\ntext");
    expect(r).toEqual([
      { line: 1, endLine: 4, kind: "list" },
      { line: 2, endLine: 3, kind: "list" },
    ]);
  });

  it("keeps a list item together across a blank line when deeper text follows", () => {
    const r = foldRanges("1. a\n\n   more\n2. b");
    expect(r).toEqual([{ line: 1, endLine: 3, kind: "list" }]);
  });

  it("handles CRLF text", () => {
    expect(foldRanges("# A\r\ntext")).toEqual([{ line: 1, endLine: 2, kind: "heading" }]);
  });
});

describe("hiddenBlocks", () => {
  it("hides the blocks under a folded heading only", () => {
    // h1, p, h2, p, h1, p
    const levels = [1, 0, 2, 0, 1, 0];
    expect([...hiddenBlocks(levels, new Set([0]))]).toEqual([1, 2, 3]);
    expect([...hiddenBlocks(levels, new Set([2]))]).toEqual([3]);
    expect([...hiddenBlocks(levels, new Set())]).toEqual([]);
  });

  it("ignores indexes that are no heading", () => {
    expect(hiddenBlocks([1, 0], new Set([1])).size).toBe(0);
  });
});

describe("fold state", () => {
  it("normalizes lines", () => {
    expect(normalizeLines([5, 2, 2, 0, -1, 1.5, 9])).toEqual([2, 5, 9]);
  });

  it("round-trips and drops what is malformed", () => {
    expect(parseFoldState(serializeFoldState({ "/a.md": [3, 1] }))).toEqual({ "/a.md": [3, 1].sort((a, b) => a - b) });
    expect(parseFoldState(null)).toEqual({});
    expect(parseFoldState("not json")).toEqual({});
    expect(parseFoldState("[1]")).toEqual({});
    expect(parseFoldState('{"/a.md":"x","/b.md":[2,"y"],"/c.md":[]}')).toEqual({ "/b.md": [2] });
  });
});

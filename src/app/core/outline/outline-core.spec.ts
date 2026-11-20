import { describe, expect, it } from "vitest";

import { buildOutline, collapseToLevel, currentHeading, foldable, markedHeading, outlineOf } from "./outline-core";

describe("outlineOf", () => {
  it("lists ATX headings with their 1-based line", () => {
    expect(outlineOf("# A\ntext\n## B ##\n###### C\n####### no\n#nospace")).toEqual([
      { level: 1, text: "A", line: 1 },
      { level: 2, text: "B", line: 3 },
      { level: 6, text: "C", line: 4 },
    ]);
  });

  it("skips frontmatter and fenced code and counts their lines", () => {
    const text = "---\n# not: a heading\n---\n# Real\n```md\n# in code\n```\n~~~~\n# tilde\n~~~~\n## After";
    expect(outlineOf(text)).toEqual([
      { level: 1, text: "Real", line: 4 },
      { level: 2, text: "After", line: 11 },
    ]);
  });

  it("keeps a longer fence open until a matching close", () => {
    expect(outlineOf("````\n```\n# x\n```\n````\n# y")).toEqual([{ level: 1, text: "y", line: 6 }]);
  });

  it("strips inline markup and handles CRLF and a BOM", () => {
    const text = "﻿# **Bold** [[Note|alias]] [link](http://x) `code`\r\n## [[Target]]\r\n#\r\n";
    expect(outlineOf(text)).toEqual([
      { level: 1, text: "Bold alias link code", line: 1 },
      { level: 2, text: "Target", line: 2 },
    ]);
  });

  it("is empty for a note without headings", () => {
    expect(outlineOf("")).toEqual([]);
    expect(outlineOf("just text")).toEqual([]);
  });
});

describe("buildOutline", () => {
  it("nests by level and numbers the headings in document order", () => {
    const tree = buildOutline(outlineOf("# A\n## B\n### C\n## D\n# E"));
    expect(tree.map((n) => n.text)).toEqual(["A", "E"]);
    expect(tree[0]!.children.map((n) => n.text)).toEqual(["B", "D"]);
    expect(tree[0]!.children[0]!.children.map((n) => [n.text, n.index])).toEqual([["C", 2]]);
    expect(tree[1]!.index).toBe(4);
  });

  it("attaches a heading after a skipped level to the nearest lower one", () => {
    const tree = buildOutline(outlineOf("# A\n### C\n## B"));
    expect(tree[0]!.children.map((n) => n.text)).toEqual(["C", "B"]);
  });

  it("keeps a leading deeper heading at the top level", () => {
    const tree = buildOutline(outlineOf("## A\n# B"));
    expect(tree.map((n) => n.text)).toEqual(["A", "B"]);
  });
});

describe("currentHeading", () => {
  const headings = outlineOf("intro\n# A\ntext\n## B\ntext\ntext\n# C");
  it("is the last heading at or above the top line", () => {
    expect(currentHeading(headings, 2)).toBe(0);
    expect(currentHeading(headings, 3)).toBe(0);
    expect(currentHeading(headings, 4)).toBe(1);
    expect(currentHeading(headings, 6)).toBe(1);
    expect(currentHeading(headings, 7)).toBe(2);
    expect(currentHeading(headings, 999)).toBe(2);
  });
  it("is -1 before the first heading or without a position", () => {
    expect(currentHeading(headings, 1)).toBe(-1);
    expect(currentHeading(headings, null)).toBe(-1);
    expect(currentHeading([], 5)).toBe(-1);
  });
});

describe("folding", () => {
  const tree = () => buildOutline(outlineOf("# A\n## B\n### C\n## D\n# E\n## F"));

  it("lists the headings that have children", () => {
    expect(foldable(tree())).toEqual([0, 1, 4]);
  });

  it("folds everything from a level down", () => {
    expect([...collapseToLevel(tree(), 1)]).toEqual([0, 1, 4]);
    expect([...collapseToLevel(tree(), 2)]).toEqual([1]);
    expect([...collapseToLevel(tree(), 3)]).toEqual([]);
  });

  it("marks the current heading, or its outermost folded ancestor", () => {
    const t = tree();
    expect(markedHeading(t, 2, new Set())).toBe(2);
    expect(markedHeading(t, 2, new Set([1]))).toBe(1);
    expect(markedHeading(t, 2, new Set([0, 1]))).toBe(0);
    expect(markedHeading(t, 1, new Set([1]))).toBe(1);
    expect(markedHeading(t, 5, new Set([0]))).toBe(5);
    expect(markedHeading(t, -1, new Set([0]))).toBe(-1);
  });
});

import { describe, expect, it } from "vitest";

import { diffLines, diffStat, splitLines, tokenize, wordDiff } from "./line-diff";

describe("splitLines", () => {
  it("ignores the trailing line break and reads CRLF", () => {
    expect(splitLines("")).toEqual([]);
    expect(splitLines("a\nb\n")).toEqual(["a", "b"]);
    expect(splitLines("a\r\nb")).toEqual(["a", "b"]);
    expect(splitLines("\n")).toEqual([""]);
  });
});

describe("diffLines", () => {
  it("marks no change as same", () => {
    expect(diffLines("a\nb", "a\nb").map((r) => r.kind)).toEqual(["same", "same"]);
  });

  it("finds added and removed lines", () => {
    const rows = diffLines("a\nb\nc", "a\nc\nd");
    expect(rows.map((r) => [r.kind, r.text])).toEqual([
      ["same", "a"],
      ["del", "b"],
      ["same", "c"],
      ["add", "d"],
    ]);
    expect(diffStat(rows)).toEqual({ added: 1, removed: 1 });
  });

  it("shows a created and a deleted note as all added / all removed", () => {
    expect(diffLines("", "x\ny").map((r) => r.kind)).toEqual(["add", "add"]);
    expect(diffLines("x\ny", "").map((r) => r.kind)).toEqual(["del", "del"]);
    expect(diffLines("", "")).toEqual([]);
  });

  it("highlights the words of a changed line", () => {
    const rows = diffLines("the quick fox", "the slow fox");
    expect(rows.map((r) => r.kind)).toEqual(["del", "add"]);
    expect(rows[0].segments).toEqual([
      { text: "the ", changed: false },
      { text: "quick", changed: true },
      { text: " fox", changed: false },
    ]);
    expect(rows[1].segments?.filter((s) => s.changed).map((s) => s.text)).toEqual(["slow"]);
  });

  it("pairs removed and added lines in order; surplus lines have no segments", () => {
    const rows = diffLines("one\ntwo", "uno");
    expect(rows.map((r) => [r.kind, r.segments !== undefined])).toEqual([
      ["del", true],
      ["del", false],
      ["add", true],
    ]);
  });

  it("rebuilds both texts from the rows", () => {
    const a = "x\ny\nz\nw";
    const b = "x\nq\nz\nw\nv";
    const rows = diffLines(a, b);
    expect(
      rows
        .filter((r) => r.kind !== "add")
        .map((r) => r.text)
        .join("\n"),
    ).toBe(a);
    expect(
      rows
        .filter((r) => r.kind !== "del")
        .map((r) => r.text)
        .join("\n"),
    ).toBe(b);
  });

  it("copes with a large change without a table", () => {
    const a = Array.from({ length: 3000 }, (_, i) => `a${i}`).join("\n");
    const b = Array.from({ length: 3000 }, (_, i) => `b${i}`).join("\n");
    expect(diffStat(diffLines(a, b))).toEqual({ added: 3000, removed: 3000 });
  });
});

describe("wordDiff", () => {
  it("tokenizes losslessly", () => {
    const line = "Hello, wörld  [[link]] 42";
    expect(tokenize(line).join("")).toBe(line);
  });

  it("marks everything on a side that has nothing in common", () => {
    const w = wordDiff("abc", "xyz");
    expect(w.old).toEqual([{ text: "abc", changed: true }]);
    expect(w.new).toEqual([{ text: "xyz", changed: true }]);
  });
});

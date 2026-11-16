import { describe, expect, it } from "vitest";

import { findInParts, findMatches, stepIndex } from "./find-core";

const plain = { caseSensitive: false, regex: false };

describe("findMatches", () => {
  it("finds every occurrence, ignoring case by default", () => {
    expect(findMatches("Foo foo FOO", "foo", plain)).toEqual([
      { from: 0, to: 3 },
      { from: 4, to: 7 },
      { from: 8, to: 11 },
    ]);
  });

  it("respects the case option", () => {
    expect(findMatches("Foo foo", "foo", { ...plain, caseSensitive: true })).toEqual([{ from: 4, to: 7 }]);
  });

  it("treats the query literally unless regex is on", () => {
    expect(findMatches("a.c abc", "a.c", plain)).toEqual([{ from: 0, to: 3 }]);
    expect(findMatches("a.c abc", "a.c", { ...plain, regex: true })).toHaveLength(2);
  });

  it("returns the error of an invalid regex", () => {
    expect(typeof findMatches("x", "(", { ...plain, regex: true })).toBe("string");
  });

  it("finds nothing for an empty query and skips empty matches", () => {
    expect(findMatches("abc", "", plain)).toEqual([]);
    expect(findMatches("abc", "x*", { ...plain, regex: true })).toEqual([]);
  });
});

describe("findInParts", () => {
  it("finds a match that spans two inline parts", () => {
    const parts = [
      { text: "a fo", group: 0 },
      { text: "o b", group: 0 },
    ];
    const result = findInParts(parts, "foo", plain);
    expect(result).toEqual({
      matches: [{ from: 2, to: 5 }],
      segments: [
        { part: 0, from: 2, to: 4, match: 0 },
        { part: 1, from: 0, to: 1, match: 0 },
      ],
    });
  });

  it("does not match across blocks", () => {
    const parts = [
      { text: "fo", group: 0 },
      { text: "o", group: 1 },
    ];
    expect(findInParts(parts, "foo", plain)).toEqual({ matches: [], segments: [] });
  });

  it("maps matches of later parts after a block break", () => {
    const parts = [
      { text: "ab", group: 0 },
      { text: "ab", group: 1 },
    ];
    const result = findInParts(parts, "ab", plain);
    expect(result).not.toBeTypeOf("string");
    expect((result as { segments: unknown[] }).segments).toEqual([
      { part: 0, from: 0, to: 2, match: 0 },
      { part: 1, from: 0, to: 2, match: 1 },
    ]);
  });
});

describe("stepIndex", () => {
  it("wraps around in both directions", () => {
    expect(stepIndex(2, 1, 3)).toBe(0);
    expect(stepIndex(0, -1, 3)).toBe(2);
  });

  it("starts at the ends and handles no matches", () => {
    expect(stepIndex(-1, 1, 3)).toBe(0);
    expect(stepIndex(-1, -1, 3)).toBe(2);
    expect(stepIndex(0, 1, 0)).toBe(-1);
  });
});

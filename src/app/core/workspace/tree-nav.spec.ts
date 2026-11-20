import { describe, expect, it } from "vitest";

import { focusTarget, parentIndex, rangeBetween, typeAheadMatch } from "./tree-nav";

describe("tree navigation", () => {
  it("moves the focus and stops at the ends", () => {
    expect(focusTarget(3, 0, "ArrowDown")).toBe(1);
    expect(focusTarget(3, 2, "ArrowDown")).toBe(2);
    expect(focusTarget(3, 0, "ArrowUp")).toBe(0);
    expect(focusTarget(3, 1, "Home")).toBe(0);
    expect(focusTarget(3, 1, "End")).toBe(2);
    expect(focusTarget(0, -1, "ArrowDown")).toBe(-1);
  });

  it("jumps to the next row starting with the typed letters", () => {
    const names = ["Alpha", "beta", "Bravo", "Charlie"];
    expect(typeAheadMatch(names, 0, "b")).toBe(1);
    expect(typeAheadMatch(names, 1, "b")).toBe(2);
    expect(typeAheadMatch(names, 2, "b")).toBe(1);
    expect(typeAheadMatch(names, 0, "br")).toBe(2);
    expect(typeAheadMatch(names, 0, "z")).toBe(-1);
    expect(typeAheadMatch(names, 0, "")).toBe(-1);
  });

  it("finds the parent row", () => {
    expect(parentIndex([0, 1, 1, 0, 1], 2)).toBe(0);
    expect(parentIndex([0, 1, 1, 0, 1], 4)).toBe(3);
    expect(parentIndex([0, 1], 0)).toBe(-1);
  });

  it("lists a range in either direction", () => {
    expect(rangeBetween(1, 3)).toEqual([1, 2, 3]);
    expect(rangeBetween(3, 1)).toEqual([1, 2, 3]);
  });
});

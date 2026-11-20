import { describe, expect, it } from "vitest";

import {
  boldMarkers,
  checkbox,
  checklistMarkdown,
  clampFontSize,
  toggledCheckbox,
} from "./decoration-logic";

describe("boldMarkers", () => {
  it("returns the opening and closing markers", () => {
    expect(boldMarkers("a **b** c")).toEqual([
      { from: 2, to: 4 },
      { from: 5, to: 7 },
    ]);
  });

  it("handles several pairs on one line", () => {
    expect(boldMarkers("**a** **b**")).toHaveLength(4);
  });

  it("ignores unclosed or empty markers and single stars", () => {
    expect(boldMarkers("**open")).toEqual([]);
    expect(boldMarkers("**** and ** x **")).toEqual([]);
    expect(boldMarkers("*it*")).toEqual([]);
    expect(boldMarkers("")).toEqual([]);
  });
});

describe("checkbox", () => {
  it("finds an open box", () => {
    expect(checkbox("- [ ] todo")).toEqual({ from: 2, to: 5, checked: false });
  });

  it("finds a checked box, indented, any bullet", () => {
    expect(checkbox("  * [x] done")).toEqual({ from: 4, to: 7, checked: true });
    expect(checkbox("- [X] done")?.checked).toBe(true);
  });

  it("accepts a box at the end of the line", () => {
    expect(checkbox("- [ ]")).toEqual({ from: 2, to: 5, checked: false });
  });

  it("ignores lines that are not tasks", () => {
    expect(checkbox("[ ] no bullet")).toBeNull();
    expect(checkbox("- [y] other")).toBeNull();
    expect(checkbox("- [ ]x glued")).toBeNull();
    expect(checkbox("text - [ ] mid")).toBeNull();
  });
});

describe("toggledCheckbox", () => {
  it("flips both ways", () => {
    expect(toggledCheckbox(false)).toBe("[x]");
    expect(toggledCheckbox(true)).toBe("[ ]");
  });
});

describe("checklistMarkdown", () => {
  it("lists every item, marks untested ones and escapes pipes", () => {
    const md = checklistMarkdown({ typing: "ok", undo: "blocker" }, { undo: "a|b\nc" });
    expect(md).toContain("| typing | ok |  |");
    expect(md).toContain("| undo | blocker | a\\|b c |");
    expect(md).toContain("| dictation | untested |  |");
    expect(md.split("\n")).toHaveLength(13);
  });
});

describe("clampFontSize", () => {
  it("keeps valid sizes and parses stored strings", () => {
    expect(clampFontSize(16)).toBe(16);
    expect(clampFontSize("12")).toBe(12);
  });

  it("clamps to the bounds", () => {
    expect(clampFontSize(2)).toBe(8);
    expect(clampFontSize(99)).toBe(28);
  });

  it("falls back to 14 for junk", () => {
    expect(clampFontSize(null)).toBe(14);
    expect(clampFontSize("abc")).toBe(14);
    expect(clampFontSize(NaN)).toBe(14);
  });
});

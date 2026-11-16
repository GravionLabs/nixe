import { describe, expect, it } from "vitest";
import { partLineOffset, setTaskState } from "./task-toggle";

describe("setTaskState", () => {
  it("ticks and unticks the task on the line", () => {
    expect(setTaskState("- [ ] a\n- [ ] b\n", 1, true)).toBe("- [ ] a\n- [x] b\n");
    expect(setTaskState("- [x] a\n- [x] b\n", 0, false)).toBe("- [ ] a\n- [x] b\n");
    expect(setTaskState("- [X] a", 0, false)).toBe("- [ ] a");
  });

  it("handles nested lists, ordered lists, other bullets and quotes", () => {
    const text = "- [ ] a\n  - [ ] b\n    * [ ] c\n1. [ ] d\n> - [ ] e\n";
    expect(setTaskState(text, 1, true)).toBe("- [ ] a\n  - [x] b\n    * [ ] c\n1. [ ] d\n> - [ ] e\n");
    expect(setTaskState(text, 2, true)).toContain("    * [x] c");
    expect(setTaskState(text, 3, true)).toContain("1. [x] d");
    expect(setTaskState(text, 4, true)).toContain("> - [x] e");
  });

  it("leaves other markers alone", () => {
    expect(setTaskState("- [/] half\n", 0, true)).toBeNull();
    expect(setTaskState("- [-] dropped\n", 0, false)).toBeNull();
  });

  it("returns null for a line that is no task, is out of range or is already in that state", () => {
    expect(setTaskState("text [ ] here\n- item\n", 0, true)).toBeNull();
    expect(setTaskState("- item\n", 0, true)).toBeNull();
    expect(setTaskState("- [ ] a", 5, true)).toBeNull();
    expect(setTaskState("- [ ] a", -1, true)).toBeNull();
    expect(setTaskState("- [x] a", 0, true)).toBeNull();
    expect(setTaskState("- [X] a", 0, true)).toBeNull();
  });

  it("changes one character and keeps CRLF and the rest of the line", () => {
    expect(setTaskState("- [ ] a [x] b\r\n- [ ] c\r\n", 0, true)).toBe("- [x] a [x] b\r\n- [ ] c\r\n");
  });
});

describe("partLineOffset", () => {
  const text = "\n\n# A\n\nintro\n\n## B\n\n- [ ] x\n- [ ] y ^id\n";
  it("finds where a heading section starts", () => {
    expect(partLineOffset(text, "## B\n\n- [ ] x\n- [ ] y ^id")).toBe(6);
  });
  it("finds a block whose marker was removed from the last line", () => {
    expect(partLineOffset(text, "- [ ] y")).toBe(9);
  });
  it("is 0 for a whole body and null when absent", () => {
    expect(partLineOffset(text, text)).toBe(0);
    expect(partLineOffset(text, "nope")).toBeNull();
  });
});

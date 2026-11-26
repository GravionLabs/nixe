import { describe, expect, it } from "vitest";

import { changeProperty } from "./property-change";

describe("changeProperty", () => {
  const note = "---\n# c\nStatus: draft # keep\nother:   1\n---\nBody\n";

  it("changes the key that differs in case only and keeps every other line", () => {
    expect(changeProperty(note, "status", () => "done")).toEqual({
      text: note.replace("Status: draft", "Status: done"),
      value: "done",
    });
  });

  it("prefers the exact key", () => {
    const text = "---\nA: 1\na: 2\n---\n";
    expect(changeProperty(text, "a", () => 3).text).toBe("---\nA: 1\na: 3\n---\n");
  });

  it("hands the stored value to the change and keeps the text when it stays", () => {
    const seen: unknown[] = [];
    const out = changeProperty(note, "other", (v) => (seen.push(v), v));
    expect(seen).toEqual([1]);
    expect(out).toEqual({ text: note, value: 1 });
  });

  it("does not take a property of every object for one of the note", () => {
    expect(changeProperty("---\na: 1\n---\n", "constructor", (v) => v ?? "x").value).toBe("x");
  });

  it("creates the frontmatter of a note without one", () => {
    expect(changeProperty("Body\n", "n", () => 2).text).toBe("---\nn: 2\n---\nBody\n");
  });

  it("refuses invalid frontmatter", () => {
    expect(() => changeProperty("---\n: [\n---\n", "a", () => 1)).toThrow(/Invalid frontmatter/);
  });
});

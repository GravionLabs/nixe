import { describe, expect, it } from "vitest";

import type { BaseCell } from "../../core/file/backend";
import { addItem, cellEditor, cellOfValue, removeItem, typedChange } from "./cell-edit";

const empty: BaseCell = { type: null, value: null };

describe("cellEditor", () => {
  it.each([
    ["title", "x", "text"],
    ["link", "[[Note]]", "text"],
    ["count", 3, "number"],
    ["done", false, "checkbox"],
    ["due", "2024-01-31", "date"],
    ["at", "2024-01-31 10:00", "text"],
    ["typo", "2024-02-30", "text"],
    ["month", "2024-13-01", "text"],
    ["authors", ["a"], "list"],
    ["tags", ["a"], "tags"],
    ["Aliases", "a", "tags"],
  ])("edits %s %j as %s", (property, value, editor) => {
    expect(cellEditor(property, cellOfValue(value), [])).toBe(editor);
  });

  it("types an empty cell like the other values of its column", () => {
    expect(cellEditor("n", empty, [empty, cellOfValue(1)])).toBe("number");
    expect(cellEditor("n", empty, [empty])).toBe("text");
    expect(cellEditor("n", empty, [cellOfValue({ a: 1 })])).toBe("text");
  });

  it("does not edit what would lose parts: mappings, lists of mappings and errors", () => {
    expect(cellEditor("m", { type: "text", value: { a: 1 } }, [])).toBeNull();
    expect(cellEditor("m", { type: "list", value: [{ a: 1 }] }, [])).toBeNull();
    expect(cellEditor("m", { type: "error", value: "bad" }, [])).toBeNull();
  });
});

describe("cell changes", () => {
  it("takes typed text as it is and a number only when it is one", () => {
    expect(typedChange("text", " 1 ")!(null)).toBe(" 1 ");
    expect(typedChange("number", "1.5")!(null)).toBe(1.5);
    expect(typedChange("number", "")).toBeNull();
  });

  it("adds to and removes from the items the note holds", () => {
    expect(addItem("tags", "#b")!("a")).toEqual(["a", "b"]);
    expect(addItem("list", "x")!(undefined)).toEqual(["x"]);
    expect(addItem("list", "A")!(["a"])).toEqual(["a"]);
    expect(addItem("list", "  ")).toBeNull();
    expect(removeItem("list", 2)([1, 2, 3])).toEqual([1, 3]);
    expect(removeItem("tags", "a")("a, b")).toEqual(["b"]);
    expect(removeItem("list", "z")(["a"])).toEqual(["a"]);
  });
});

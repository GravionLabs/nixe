import { describe, expect, it } from "vitest";

import {
  chipSuggestions,
  chipText,
  initialValue,
  isDateOnly,
  listItems,
  parseNumber,
  propertiesSummary,
} from "./properties-edit";

describe("properties-edit", () => {
  it("starts each type with a value of that type", () => {
    expect(initialValue("text", "2026-01-02")).toBe("");
    expect(initialValue("number", "2026-01-02")).toBe(0);
    expect(initialValue("checkbox", "2026-01-02")).toBe(false);
    expect(initialValue("date", "2026-01-02")).toBe("2026-01-02");
    expect(initialValue("tags", "2026-01-02")).toEqual([]);
  });

  it("reads list items from lists, scalars and nothing", () => {
    expect(listItems(["a", " b ", "", 3])).toEqual(["a", "b", "3"]);
    expect(listItems("x")).toEqual(["x"]);
    expect(listItems(null)).toEqual([]);
    expect(listItems("")).toEqual([]);
  });

  it("strips the # of tags only", () => {
    expect(chipText("tags", " #idea ")).toBe("idea");
    expect(chipText("tag", "##a")).toBe("a");
    expect(chipText("aliases", "#x")).toBe("#x");
  });

  it("suggests unused index values, prefix matches first", () => {
    const all = ["project", "idea/project", "inbox", "Idea"];
    expect(chipSuggestions(all, "", ["inbox"])).toEqual(["project", "idea/project", "Idea"]);
    expect(chipSuggestions(all, "#pro", [])).toEqual(["project", "idea/project"]);
    expect(chipSuggestions(all, "idea", ["IDEA"])).toEqual(["idea/project"]);
    expect(chipSuggestions(all, "", [], 2)).toHaveLength(2);
  });

  it("parses numbers", () => {
    expect(parseNumber("4.5")).toBe(4.5);
    expect(parseNumber("")).toBeNull();
    expect(parseNumber("abc")).toBeNull();
  });

  it("detects date-only values", () => {
    expect(isDateOnly("2024-01-02")).toBe(true);
    expect(isDateOnly("2024-01-02T10:00")).toBe(false);
    expect(isDateOnly(5)).toBe(false);
  });
});

describe("propertiesSummary", () => {
  it("counts and shows the first properties, lists joined and long values truncated", () => {
    expect(
      propertiesSummary([
        { key: "tags", value: ["rust", "idea"] },
        { key: "status", value: "draft" },
        { key: "x", value: 1 },
      ]),
    ).toBe("Properties · 3 · tags: rust, idea · status: draft");
    expect(propertiesSummary([{ key: "a", value: "x".repeat(40) }])).toBe(
      `Properties · 1 · a: ${"x".repeat(23)}…`,
    );
  });
});

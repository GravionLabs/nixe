import { describe, expect, it } from "vitest";

import {
  applyCompletion,
  completeNames,
  insertAt,
  isUrl,
  markdownLink,
  wikilinkQueryAt,
} from "./capture-core";

describe("wikilinkQueryAt", () => {
  it("finds the open [[ before the caret", () => {
    expect(wikilinkQueryAt("see [[Pro", 9)).toEqual({ start: 4, query: "Pro" });
    expect(wikilinkQueryAt("[[", 2)).toEqual({ start: 0, query: "" });
  });

  it("is null when the link is closed, broken by a line or the caret is before it", () => {
    expect(wikilinkQueryAt("[[a]] b", 7)).toBeNull();
    expect(wikilinkQueryAt("[[a\nb", 5)).toBeNull();
    expect(wikilinkQueryAt("[[a#h", 5)).toBeNull();
    expect(wikilinkQueryAt("x [[a", 1)).toBeNull();
    expect(wikilinkQueryAt("plain", 5)).toBeNull();
  });
});

describe("completeNames", () => {
  const names = ["Project plan", "Plan B", "Zebra", "plain"];

  it("matches every word, prefix matches first", () => {
    expect(completeNames(names, "pla")).toEqual(["Plan B", "plain", "Project plan"]);
    expect(completeNames(names, "plan pro")).toEqual(["Project plan"]);
    expect(completeNames(names, "xyz")).toEqual([]);
  });

  it("lists the first names for an empty query and respects the limit", () => {
    expect(completeNames(names, "", 2)).toEqual(["Project plan", "Plan B"]);
  });
});

describe("applyCompletion", () => {
  it("replaces the open link and puts the caret behind it", () => {
    const link = wikilinkQueryAt("see [[Pro", 9)!;
    expect(applyCompletion("see [[Pro", 9, link, "Project plan")).toEqual({
      text: "see [[Project plan]]",
      caret: 20,
    });
  });

  it("keeps the text after the caret and does not double ]]", () => {
    const link = wikilinkQueryAt("a [[Pr]] b", 6)!;
    expect(applyCompletion("a [[Pr]] b", 6, link, "Pro")).toEqual({
      text: "a [[Pro]] b",
      caret: 9,
    });
  });
});

describe("links", () => {
  it("recognises a single URL", () => {
    expect(isUrl(" https://example.com/a ")).toBe(true);
    expect(isUrl("https://")).toBe(false);
    expect(isUrl("read https://example.com")).toBe(false);
    expect(isUrl("ftp://example.com")).toBe(false);
  });

  it("builds a Markdown link with the title", () => {
    expect(markdownLink("https://example.com", "Example\n Domain")).toBe(
      "[Example Domain](https://example.com)",
    );
    expect(markdownLink("https://e.com/a_(b)", "A [x]")).toBe("[A \\[x\\]](https://e.com/a_(b%29)");
  });

  it("falls back to the bare URL without a title", () => {
    expect(markdownLink(" https://example.com ", null)).toBe("https://example.com");
    expect(markdownLink("https://example.com", "  ")).toBe("https://example.com");
  });
});

describe("insertAt", () => {
  it("replaces the selection", () => {
    expect(insertAt("abcdef", 2, 4, "XY")).toEqual({ text: "abXYef", caret: 4 });
  });
});

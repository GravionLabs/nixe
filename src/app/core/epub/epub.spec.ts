import { describe, expect, it } from "vitest";
import type { FoliateBook } from "foliate-js/view.js";

import { bookCss, bookTitle, flattenToc } from "./epub";

const book = (title: FoliateBook["metadata"]["title"]): FoliateBook => ({
  metadata: { title },
  sections: [],
});

describe("bookTitle", () => {
  it("takes a text title, trimmed", () => {
    expect(bookTitle(book("  Dune "), "dune")).toBe("Dune");
  });

  it("takes the first title of a map of languages", () => {
    expect(bookTitle(book({ en: "Dune", de: "Der Wüstenplanet" }), "dune")).toBe("Dune");
  });

  it("falls back for a missing or blank title", () => {
    expect(bookTitle(book(undefined), "dune")).toBe("dune");
    expect(bookTitle(book("  "), "dune")).toBe("dune");
    expect(bookTitle(book({ en: "" }), "dune")).toBe("dune");
  });
});

describe("flattenToc", () => {
  it("lists the chapters in reading order with their depth", () => {
    const rows = flattenToc([
      {
        label: "Part 1",
        href: "p1.xhtml",
        subitems: [{ label: "Chapter 1", href: "c1.xhtml" }],
      },
      { label: " ", href: "p2.xhtml" },
    ]);
    expect(rows).toEqual([
      { label: "Part 1", href: "p1.xhtml", depth: 0 },
      { label: "Chapter 1", href: "c1.xhtml", depth: 1 },
      { label: "p2.xhtml", href: "p2.xhtml", depth: 0 },
    ]);
  });

  it("is empty without a table of contents", () => {
    expect(flattenToc(undefined)).toEqual([]);
  });
});

describe("bookCss", () => {
  it("sets the colors of the light and the dark theme", () => {
    expect(bookCss(false, 100)).toContain("color-scheme: light");
    expect(bookCss(true, 100)).toContain("color-scheme: dark");
    expect(bookCss(true, 100)).not.toBe(bookCss(false, 100));
  });

  it("scales the text with the zoom", () => {
    expect(bookCss(false, 100)).toContain("font-size: 100% !important");
    expect(bookCss(false, 150)).toContain("font-size: 150% !important");
  });
});

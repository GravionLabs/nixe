// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** Spike for ADR 0009: foliate-js loads and opens the fixture EPUB (#485). */
describe("foliate-js", () => {
  const sample = () =>
    new File([readFileSync("fixtures/books/sample.epub")], "sample.epub", {
      type: "application/epub+zip",
    });

  it("opens the metadata of the fixture EPUB", async () => {
    const { makeBook } = await import("foliate-js/view.js");

    const book = await makeBook(sample());

    expect(book.metadata.title).toBe("Nixe Sample Book");
    expect(book.metadata.language).toBe("en");
    expect(book.metadata.identifier).toBe("urn:uuid:5b0e8f4a-2c1d-4e8b-9a3f-7d6c1e2b4a90");
  });

  it("reads the spine and the table of contents", async () => {
    const { makeBook } = await import("foliate-js/view.js");

    const book = await makeBook(sample());

    expect(book.sections.map((section) => section.id)).toEqual([
      "OEBPS/chapter-1.xhtml",
      "OEBPS/chapter-2.xhtml",
    ]);
    expect(book.toc?.map((item) => item.label)).toEqual(["Chapter 1", "Chapter 2"]);
  });
});

import { describe, expect, it } from "vitest";
import { parseWikilinkTarget, resolveWikilink } from "./wikilink-resolver";

const files = [
  "Index.md",
  "Note.md",
  "folder/Deep.md",
  "folder/Twin.md",
  "Twin.md",
  "a/Same.md",
  "b/Same.md",
  "img/pic.png",
];

describe("parseWikilinkTarget", () => {
  it("splits note, heading and block", () => {
    expect(parseWikilinkTarget("Note")).toEqual({ note: "Note", heading: null, block: null });
    expect(parseWikilinkTarget("Note#Head er")).toEqual({
      note: "Note",
      heading: "Head er",
      block: null,
    });
    expect(parseWikilinkTarget("Note#^b1")).toEqual({ note: "Note", heading: null, block: "b1" });
    expect(parseWikilinkTarget("#Only")).toEqual({ note: "", heading: "Only", block: null });
  });
});

describe("resolveWikilink", () => {
  it("resolves by basename, with or without extension", () => {
    expect(resolveWikilink("Note", files)).toBe("Note.md");
    expect(resolveWikilink("Note.md", files)).toBe("Note.md");
    expect(resolveWikilink("Deep", files)).toBe("folder/Deep.md");
  });
  it("ignores heading and block", () => {
    expect(resolveWikilink("Note#Heading", files)).toBe("Note.md");
    expect(resolveWikilink("Note#^b", files)).toBe("Note.md");
  });
  it("resolves paths, exact first", () => {
    expect(resolveWikilink("folder/Deep", files)).toBe("folder/Deep.md");
    expect(resolveWikilink("folder/Twin", files)).toBe("folder/Twin.md");
    expect(resolveWikilink("Twin", files)).toBe("Twin.md");
  });
  it("is case-insensitive", () => {
    expect(resolveWikilink("note", files)).toBe("Note.md");
    expect(resolveWikilink("FOLDER/deep", files)).toBe("folder/Deep.md");
  });
  it("returns null for ambiguous and missing targets", () => {
    expect(resolveWikilink("Same", files)).toBeNull();
    expect(resolveWikilink("Missing", files)).toBeNull();
    expect(resolveWikilink("#Heading", files)).toBeNull();
  });
  it("resolves non-markdown files by full name", () => {
    expect(resolveWikilink("pic.png", files)).toBe("img/pic.png");
  });
});

import { describe, expect, it } from "vitest";
import { extractBlock, extractHeadingSection, notePart, parseEmbed } from "./embed";

describe("parseEmbed", () => {
  it("classifies notes, images and other files", () => {
    expect(parseEmbed("Note")?.kind).toBe("note");
    expect(parseEmbed("Note.md#H")?.kind).toBe("note");
    expect(parseEmbed("a/b.PNG")?.kind).toBe("image");
    expect(parseEmbed("doc.pdf")?.kind).toBe("file");
  });
  it("parses sizes", () => {
    expect(parseEmbed("i.png|300")).toMatchObject({ width: 300, height: null });
    expect(parseEmbed("i.png|300x200")).toMatchObject({ width: 300, height: 200 });
    expect(parseEmbed("i.png|alt")).toMatchObject({ width: null, height: null });
    expect(parseEmbed("i.png|alt|40")).toMatchObject({ width: 40 });
  });
  it("rejects empty targets", () => expect(parseEmbed(" |3")).toBeNull());
});

const note = "---\ntitle: x\n---\n# A\nintro\n## B\nb1\n```\n## not a heading\n```\n### C\nc1\n## D\nd1 ^blk\n\npara one\npara two ^p2\n\n- item ^li\n";

describe("extractHeadingSection", () => {
  it("returns the section up to the next heading of the same level", () => {
    expect(extractHeadingSection(note, "b")).toBe("## B\nb1\n```\n## not a heading\n```\n### C\nc1");
  });
  it("runs to the end for the last section", () => {
    expect(extractHeadingSection(note, "D")).toContain("- item ^li");
  });
  it("returns null when missing", () => expect(extractHeadingSection(note, "Z")).toBeNull());
});

describe("extractBlock", () => {
  it("returns the paragraph without the marker", () => {
    expect(extractBlock(note, "p2")).toBe("para one\npara two");
    expect(extractBlock(note, "blk")).toBe("d1");
  });
  it("returns only the list item", () => expect(extractBlock(note, "li")).toBe("- item"));
  it("returns null when missing", () => expect(extractBlock(note, "zz")).toBeNull());
  it("supports a marker on its own line", () => {
    expect(extractBlock("first\nsecond\n\n^id\n", "id")).toBe("first\nsecond");
  });
});

describe("notePart", () => {
  const text = "---\ntitle: T\n---\n# One\n\nintro\n\n## Two\n\ntwo text ^b1\n";

  it("is the body without frontmatter for a plain note", () => {
    const part = notePart(text, "Note");
    expect(part?.start).toBe(0);
    expect(part?.text).toContain("# One");
    expect(part?.text).not.toContain("title");
  });

  it("is the section of a heading target", () => {
    expect(notePart(text, "Note#Two")?.text).toBe("## Two\n\ntwo text ^b1");
  });

  it("is the block of a block target", () => {
    expect(notePart(text, "Note#^b1")?.text).toBe("two text");
  });

  it("is null for a missing heading or block", () => {
    expect(notePart(text, "Note#Nope")).toBeNull();
    expect(notePart(text, "Note#^nope")).toBeNull();
  });
});

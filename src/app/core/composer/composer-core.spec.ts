import { describe, expect, it } from "vitest";

import { describeChanges, headingLineAt, headingTextAt, targetNotePath } from "./composer-core";

describe("headingLineAt", () => {
  const text = "---\ntitle: x\n# not a heading\n---\nintro\n# A\ntext\n```\n# code\n```\n## B ##\nmore\n";

  it("finds the heading above the cursor", () => {
    expect(headingLineAt(text, 7)).toBe(6);
    expect(headingLineAt(text, 12)).toBe(11);
  });

  it("is null before the first heading and skips frontmatter", () => {
    expect(headingLineAt(text, 5)).toBeNull();
    expect(headingLineAt(text, 3)).toBeNull();
  });

  it("does not take a comment in a code fence", () => {
    expect(headingLineAt(text, 9)).toBe(6);
  });

  it("is null for a bare # and for a note without headings", () => {
    expect(headingLineAt("#\ntext", 2)).toBeNull();
    expect(headingLineAt("plain\n#tag\n", 2)).toBeNull();
  });
});

describe("headingTextAt", () => {
  it("drops the marks", () => {
    expect(headingTextAt("# A\n## B ##\n", 2)).toBe("B");
    expect(headingTextAt("# A\n", 1)).toBe("A");
    expect(headingTextAt("# A\n", 5)).toBe("");
  });
});

describe("targetNotePath", () => {
  it("adds the extension and puts a bare name into the folder", () => {
    expect(targetNotePath("Idea", "Inbox")).toBe("Inbox/Idea.md");
    expect(targetNotePath("Idea.md", "")).toBe("Idea.md");
  });

  it("takes typed folders as they are", () => {
    expect(targetNotePath("a/b/Idea", "Inbox")).toBe("a/b/Idea.md");
    expect(targetNotePath("../x\\y", "Inbox")).toBe("x/y.md");
  });

  it("drops invalid characters and refuses an empty name", () => {
    expect(targetNotePath("a:b?c", "")).toBe("abc.md");
    expect(targetNotePath("  ", "")).toBeNull();
    expect(targetNotePath("a/", "")).toBe("a.md");
  });
});

describe("describeChanges", () => {
  it("lists the notes with what happens to them", () => {
    expect(
      describeChanges([
        { path: "B.md", action: "append", links: 1 },
        { path: "A.md", action: "trash", links: 0 },
      ]),
    ).toBe("• B.md (text added, 1 link)\n• A.md (moved to .trash/)");
  });

  it("cuts a long list", () => {
    const many = Array.from({ length: 5 }, (_, i) => ({ path: `${i}.md`, action: "update" as const, links: 2 }));
    expect(describeChanges(many, 2).split("\n")).toHaveLength(3);
    expect(describeChanges(many, 2)).toContain("… and 3 more");
  });
});

import { describe, expect, it } from "vitest";

import { SwitcherEntry, fileLabel, fuzzyMatch, fuzzyScore, highlightParts, rank } from "./fuzzy";

const entry = (path: string, aliases: string[] = []): SwitcherEntry => ({
  path,
  title: fileLabel(path),
  aliases,
});
const paths = (query: string, entries: SwitcherEntry[], recent: string[] = []) =>
  rank(entries, query, recent).map((m) => m.entry.path);

describe("fuzzyScore", () => {
  it("needs every character in order", () => {
    expect(fuzzyScore("abc", "a-b-c")).not.toBeNull();
    expect(fuzzyScore("acb", "abc")).toBeNull();
    expect(fuzzyScore("abcd", "abc")).toBeNull();
  });

  it("still matches when a word start would leave too little text", () => {
    expect(fuzzyScore("oct", "Project Overview")).not.toBeNull();
  });

  it("ignores case", () => {
    expect(fuzzyScore("READ", "readme")).toBe(fuzzyScore("read", "README"));
  });

  it("prefers exact, then prefix, then consecutive, then scattered", () => {
    const exact = fuzzyScore("note", "note")!;
    const prefix = fuzzyScore("note", "notebook")!;
    const inner = fuzzyScore("note", "my notes")!;
    const scattered = fuzzyScore("note", "n-o-t-e-s-x")!;
    expect(exact).toBeGreaterThan(prefix);
    expect(prefix).toBeGreaterThan(inner);
    expect(inner).toBeGreaterThan(scattered);
  });

  it("rewards word starts", () => {
    expect(fuzzyScore("pn", "project-notes")!).toBeGreaterThan(fuzzyScore("pn", "spinning")!);
  });
});

describe("rank", () => {
  const all = [
    entry("a/Meeting Notes.md"),
    entry("Notes.md"),
    entry("Note to self.md"),
    entry("Other.md"),
  ];

  it("drops notes that do not match", () => {
    expect(paths("note", all)).not.toContain("Other.md");
  });

  it("ranks the exact name first", () => {
    expect(paths("notes", all)[0]).toBe("Notes.md");
  });

  it("matches word initials", () => {
    expect(paths("mn", all)[0]).toBe("a/Meeting Notes.md");
  });

  it("matches aliases and reports which one", () => {
    const list = [entry("Home.md", ["Start page"]), entry("Other.md")];
    const [match] = rank(list, "start", []);
    expect(match?.entry.path).toBe("Home.md");
    expect(match?.isAlias).toBe(true);
    expect(match?.label).toBe("Start page");
  });

  it("prefers the file name when it matches better than the alias", () => {
    const [match] = rank([entry("Plan.md", ["Roadmap"])], "plan", []);
    expect(match?.isAlias).toBe(false);
  });

  it("puts recently opened notes first on equal scores", () => {
    const list = [entry("a/Todo.md"), entry("b/Todo.md"), entry("c/Todo.md")];
    expect(paths("todo", list, ["c/Todo.md", "b/Todo.md"])).toEqual([
      "c/Todo.md",
      "b/Todo.md",
      "a/Todo.md",
    ]);
  });

  it("does not let recency beat a better match", () => {
    const list = [entry("Notebook.md"), entry("Notes.md")];
    expect(paths("notes", list, ["Notebook.md"])[0]).toBe("Notes.md");
  });

  it("lists recent notes first, then the rest alphabetically, without a query", () => {
    const list = [entry("b.md"), entry("a.md"), entry("c.md")];
    expect(paths("", list, ["c.md"])).toEqual(["c.md", "a.md", "b.md"]);
    expect(paths("  ", list)).toEqual(["a.md", "b.md", "c.md"]);
  });

  it("returns nothing when nothing matches", () => {
    expect(rank(all, "zzz", [])).toEqual([]);
  });
});

describe("fuzzyMatch", () => {
  it("returns the positions of the matched characters", () => {
    expect(fuzzyMatch("mn", "Meeting Notes")?.positions).toEqual([0, 8]);
    expect(fuzzyMatch("note", "note")?.positions).toEqual([0, 1, 2, 3]);
  });

  it("agrees with fuzzyScore and returns null without a match", () => {
    expect(fuzzyMatch("abc", "a-b-c")?.score).toBe(fuzzyScore("abc", "a-b-c"));
    expect(fuzzyMatch("xyz", "abc")).toBeNull();
  });

  it("has no positions for an empty query", () => {
    expect(fuzzyMatch("", "abc")?.positions).toEqual([]);
  });

  it("carries the positions of the best label into rank", () => {
    const [match] = rank([entry("Home.md", ["Start page"])], "sp", []);
    expect(match?.isAlias).toBe(true);
    expect(match?.positions).toEqual([0, 6]);
  });
});

describe("highlightParts", () => {
  it("splits a label into matched and unmatched runs", () => {
    expect(highlightParts("Meeting", [0, 1, 4])).toEqual([
      { text: "Me", matched: true },
      { text: "et", matched: false },
      { text: "i", matched: true },
      { text: "ng", matched: false },
    ]);
  });

  it("returns one unmatched run without positions", () => {
    expect(highlightParts("abc", [])).toEqual([{ text: "abc", matched: false }]);
  });
});

import { describe, expect, it } from "vitest";

import { SwitcherEntry, fileLabel, fuzzyScore, rank } from "./fuzzy";

const entry = (path: string, aliases: string[] = []): SwitcherEntry => ({ path, title: fileLabel(path), aliases });
const paths = (query: string, entries: SwitcherEntry[], recent: string[] = []) =>
  rank(entries, query, recent).map((m) => m.entry.path);

describe("fuzzyScore", () => {
  it("needs every character in order", () => {
    expect(fuzzyScore("abc", "a-b-c")).not.toBeNull();
    expect(fuzzyScore("acb", "abc")).toBeNull();
    expect(fuzzyScore("abcd", "abc")).toBeNull();
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
  const all = [entry("a/Meeting Notes.md"), entry("Notes.md"), entry("Note to self.md"), entry("Other.md")];

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
    expect(paths("todo", list, ["c/Todo.md", "b/Todo.md"])).toEqual(["c/Todo.md", "b/Todo.md", "a/Todo.md"]);
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

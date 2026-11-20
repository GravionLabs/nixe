import { describe, expect, it } from "vitest";

import {
  blockOptions,
  blocksOf,
  headingLinkText,
  headingOptions,
  headingsOf,
  linkTarget,
  noteOptions,
  tagOptions,
  tagStage,
  wikilinkStage,
} from "./completion-core";

describe("wikilinkStage", () => {
  it("starts after an open [[", () => {
    expect(wikilinkStage("see [[Pro", 9)).toEqual({ kind: "note", from: 6, query: "Pro" });
    expect(wikilinkStage("[[", 2)).toEqual({ kind: "note", from: 2, query: "" });
  });

  it("is off outside a link, after a closed link and in the alias", () => {
    expect(wikilinkStage("plain text", 5)).toBeNull();
    expect(wikilinkStage("[[A]] and ", 10)).toBeNull();
    expect(wikilinkStage("[[A|Al", 6)).toBeNull();
  });

  it("offers headings after # and blocks after #^", () => {
    expect(wikilinkStage("[[Plan#Go", 9)).toEqual({
      kind: "heading",
      from: 7,
      note: "Plan",
      query: "Go",
    });
    expect(wikilinkStage("[[#", 3)).toEqual({ kind: "heading", from: 3, note: "", query: "" });
    expect(wikilinkStage("[[Plan#^ab", 10)).toEqual({
      kind: "block",
      from: 8,
      note: "Plan",
      query: "ab",
    });
    expect(wikilinkStage("[[Plan#A#B", 10)).toBeNull();
  });
});

describe("tagStage", () => {
  it("needs a # at a word start", () => {
    expect(tagStage("a #wo", 5)).toEqual({ from: 3, query: "wo" });
    expect(tagStage("#", 1)).toEqual({ from: 1, query: "" });
    expect(tagStage("(#x/y", 5)).toEqual({ from: 2, query: "x/y" });
  });

  it("ignores a # inside a word, headings and plain words", () => {
    expect(tagStage("a#b", 3)).toBeNull();
    expect(tagStage("## Title", 8)).toBeNull();
    expect(tagStage("# ", 2)).toBeNull();
    expect(tagStage("word", 4)).toBeNull();
  });
});

describe("linkTarget", () => {
  const all = ["Inbox/Plan.md", "Work/Plan.md", "Ideas.md", "Work/Deep/Plan.md"];

  it("shortest: the name, with folders only when the name is taken", () => {
    expect(linkTarget("Ideas.md", "shortest", null, all)).toBe("Ideas");
    expect(linkTarget("Inbox/Plan.md", "shortest", null, all)).toBe("Inbox/Plan");
    expect(linkTarget("Work/Deep/Plan.md", "shortest", null, all)).toBe("Deep/Plan");
    expect(linkTarget("Work/Plan.md", "shortest", null, all)).toBe("Work/Plan");
  });

  it("absolute: the path from the vault root", () => {
    expect(linkTarget("Work/Plan.md", "absolute", "Ideas.md", all)).toBe("Work/Plan");
  });

  it("relative: the path from the folder of the open note", () => {
    expect(linkTarget("Work/Plan.md", "relative", "Ideas.md", all)).toBe("Work/Plan");
    expect(linkTarget("Ideas.md", "relative", "Work/Plan.md", all)).toBe("../Ideas");
    expect(linkTarget("Work/Deep/Plan.md", "relative", "Work/Plan.md", all)).toBe("Deep/Plan");
    expect(linkTarget("Inbox/Plan.md", "relative", "Work/Deep/Plan.md", all)).toBe(
      "../../Inbox/Plan",
    );
    expect(linkTarget("Work/Plan.md", "relative", "Work/Other.md", all)).toBe("Plan");
  });
});

describe("noteOptions", () => {
  const entries = [
    { path: "Projects/Roadmap.md", title: "Roadmap", aliases: ["Plan 2026"] },
    { path: "Ideas.md", title: "Ideas", aliases: [] },
    { path: "Notes/Ideas.md", title: "Ideas", aliases: [] },
  ];

  it("matches names fuzzily and inserts the link format", () => {
    const [first] = noteOptions(entries, "road", "shortest", null);
    expect(first).toEqual({ label: "Roadmap", detail: "Projects/Roadmap.md", insert: "Roadmap" });
    expect(noteOptions(entries, "road", "absolute", null)[0]!.insert).toBe("Projects/Roadmap");
    expect(noteOptions(entries, "road", "relative", "Ideas.md")[0]!.insert).toBe(
      "Projects/Roadmap",
    );
  });

  it("matches an alias and inserts Note|Alias", () => {
    const [first] = noteOptions(entries, "plan", "shortest", null);
    expect(first).toMatchObject({ label: "Plan 2026", insert: "Roadmap|Plan 2026" });
  });

  it("disambiguates equal names and lists everything for an empty query", () => {
    const options = noteOptions(entries, "", "shortest", null);
    expect(options.map((o) => o.insert).sort()).toEqual(["Ideas", "Notes/Ideas", "Roadmap"]);
  });

  it("drops what does not match", () => {
    expect(noteOptions(entries, "zzz", "shortest", null)).toEqual([]);
  });
});

describe("headingsOf and blocksOf", () => {
  const text = [
    "---",
    "# not a heading",
    "---",
    "# Title",
    "text ^intro",
    "```",
    "## in code ^nope",
    "```",
    "## Sub heading ##",
    "####### seven",
    "- item ^list-1",
    "^alone",
  ].join("\n");

  it("lists headings outside code and front matter", () => {
    expect(headingsOf(text)).toEqual([
      { level: 1, text: "Title" },
      { level: 2, text: "Sub heading" },
    ]);
  });

  it("lists block ids outside code", () => {
    expect(blocksOf(text)).toEqual([
      { id: "intro", text: "text" },
      { id: "list-1", text: "- item" },
      { id: "alone", text: "" },
    ]);
  });

  it("writes headings so that a link does not break", () => {
    expect(headingLinkText("A: b | c [d] #e ^f")).toBe("A b c d e f");
  });
});

describe("headingOptions, blockOptions, tagOptions", () => {
  it("filters headings and blocks fuzzily", () => {
    const headings = [
      { level: 1, text: "Goals" },
      { level: 2, text: "Open questions" },
    ];
    expect(headingOptions(headings, "").map((o) => o.insert)).toEqual(["Goals", "Open questions"]);
    expect(headingOptions(headings, "oq").map((o) => o.insert)).toEqual(["Open questions"]);
    expect(headingOptions(headings, "")[1]).toMatchObject({ detail: "##" });
    const blocks = [
      { id: "a1", text: "First" },
      { id: "b2", text: "Second" },
    ];
    expect(blockOptions(blocks, "").map((o) => o.insert)).toEqual(["a1", "b2"]);
    expect(blockOptions(blocks, "sec").map((o) => o.insert)).toEqual(["b2"]);
    expect(blockOptions(blocks, "zz")).toEqual([]);
  });

  it("keeps the tags in frequency order and filters by the query", () => {
    const tags = [
      { tag: "project", count: 9 },
      { tag: "idea", count: 4 },
      { tag: "project/x", count: 1 },
    ];
    expect(tagOptions(tags, "").map((o) => o.insert)).toEqual(["project", "idea", "project/x"]);
    expect(tagOptions(tags, "pro").map((o) => o.insert)).toEqual(["project", "project/x"]);
    expect(tagOptions(tags, "")[0]).toMatchObject({ label: "project", detail: "9" });
  });
});

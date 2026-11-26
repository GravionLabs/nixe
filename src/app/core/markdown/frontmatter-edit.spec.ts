import { describe, expect, it } from "vitest";

import { editFrontmatter } from "./frontmatter-edit";
import { splitFrontmatter } from "./frontmatter";

const NOTE = `---
# the title
title: Hello   # trailing comment
tags:
  - a
  - b
count: 3

draft: false
aliases: [x, y]
---
# Body
text
`;

const set = (text: string, key: string, value: unknown) =>
  editFrontmatter(text, { kind: "set", key, value });

describe("editFrontmatter set", () => {
  it("changes only the edited value and keeps comments, order and untouched formatting", () => {
    const out = set(NOTE, "count", 4);
    expect(out).toBe(NOTE.replace("count: 3", "count: 4"));
  });

  it("keeps a trailing comment of the edited line", () => {
    expect(set(NOTE, "title", "Bye")).toBe(NOTE.replace("title: Hello ", "title: Bye "));
  });

  it("rewrites a block list in place", () => {
    const out = set(NOTE, "tags", ["a", "c", "d"]);
    expect(out).toBe(NOTE.replace("  - a\n  - b\n", "  - a\n  - c\n  - d\n"));
    expect(splitFrontmatter(out).data["tags"]).toEqual(["a", "c", "d"]);
  });

  it("turns a scalar into a list and back", () => {
    const out = set("---\na: 1\nb: 2\n---\n", "a", ["x", "y"]);
    expect(out).toBe("---\na:\n  - x\n  - y\nb: 2\n---\n");
    expect(set(out, "a", 5)).toBe("---\na: 5\nb: 2\n---\n");
  });

  it("keeps a flow list a flow list, with its padding and comment", () => {
    expect(set(NOTE, "aliases", ["z"])).toBe(NOTE.replace("aliases: [x, y]", "aliases: [z]"));
    expect(set("---\na: [ x ] # c\nb: 2\n---\n", "a", ["x", "y"])).toBe(
      "---\na: [ x, y ] # c\nb: 2\n---\n",
    );
  });

  it("keeps the quotes of a quoted text", () => {
    expect(set('---\na: "x" # c\n---\n', "a", "y")).toBe('---\na: "y" # c\n---\n');
    expect(set("---\na: 'x'\n---\n", "a", "y")).toBe("---\na: 'y'\n---\n");
  });

  it("does not fold a long text", () => {
    const long = "word ".repeat(40).trim();
    expect(set("---\na: x\n---\n", "a", long)).toBe(`---\na: ${long}\n---\n`);
  });

  it("keeps the comments of a block list when items change", () => {
    const text = "---\ntags:\n  # first\n  - a # one\n  - b # two\n  # last\n  - c\nx: 1\n---\n";
    expect(set(text, "tags", ["a", "c", "d"])).toBe(
      "---\ntags:\n  # first\n  - a # one\n  # last\n  - c\n  - d\nx: 1\n---\n",
    );
    expect(set(text, "tags", ["a", "b", "c", "d"])).toBe(text.replace("  - c\n", "  - c\n  - d\n"));
    expect(set(text, "tags", ["b", "c"])).toBe(text.replace("  - a # one\n", ""));
  });

  it("keeps the indent and the line ends of a block list", () => {
    expect(set("---\r\ntags:\r\n- a\r\n- b # c\r\n---\r\n", "tags", ["a", "b", "[[d]]"])).toBe(
      '---\r\ntags:\r\n- a\r\n- b # c\r\n- "[[d]]"\r\n---\r\n',
    );
  });

  it("empties a block list and keeps its comment lines", () => {
    const out = set("---\ntags: # t\n  # first\n  - a\nx: 1\n---\n", "tags", []);
    expect(out).toBe("---\ntags: [] # t\n  # first\nx: 1\n---\n");
    expect(splitFrontmatter(out).data).toEqual({ tags: [], x: 1 });
  });

  it.each([
    ["dc:subject:\n  - x", "dc:subject", "dc:subject: []"],
    ['"a:b":\n  - x', "a:b", '"a:b": []'],
    ["k: &a\n  - x", "k", "k: &a []"],
    ["k: !!seq\n  - x", "k", "k: !!seq []"],
  ])("empties the block list %j", (yaml, key, written) => {
    expect(set(`---\n${yaml}\n---\n`, key, [])).toBe(`---\n${written}\n---\n`);
  });

  it.each(["k: # c\n  v", "k:\n  # c\n  v", "k: | # c\n  v"])(
    "refuses to drop the comment before a value: %j",
    (yaml) => {
      expect(() => set(`---\n${yaml}\n---\n`, "k", "w")).toThrow(/comment before/);
    },
  );

  it.each([
    ["an anchored item an alias points to", "---\nl:\n  - &x a\n  - b\nm: *x\n---\n", "l", ["b"]],
    ["the only anchored item", "---\nl:\n  - &x a\nm: *x\n---\n", "l", []],
    ["an anchored item of a flow list", "---\nl: [&x a, b]\nm: *x\n---\n", "l", ["b"]],
    ["a comment that would join the value", "---\na: foo\n\n  bar # c\n---\n", "a", "a\nb"],
    ["a key behind an indented mapping", "---\n  a: x\n  z: 1\n---\n", "n", "v"],
  ])("refuses to damage the frontmatter: %s", (_, text, key, value) => {
    expect(() => set(text, key, value)).toThrow(/damaging/);
  });

  it("refuses a flow list with comments inside", () => {
    expect(() => set("---\nl: [a, # q\n  b]\n---\n", "l", ["a"])).toThrow(/comments/);
  });

  it("changes a key that is a number instead of adding a second one", () => {
    expect(set("---\n2024: a\n---\n", "2024", "b")).toBe("---\n2024: b\n---\n");
  });

  it("writes a value for a key without one", () => {
    expect(set("---\na:\nb: 2\n---\n", "a", "v")).toBe("---\na: v\nb: 2\n---\n");
  });

  it("keeps a comment after a key without a value", () => {
    expect(set("---\na: # c\nb: 2\n---\n", "a", 5)).toBe("---\na: 5 # c\nb: 2\n---\n");
    expect(set("---\na:\nb: 2\n---\n", "a", ["x"])).toBe("---\na:\n  - x\nb: 2\n---\n");
  });

  it("refuses to change a value that an alias points to", () => {
    expect(() => set("---\na: &x 1\nb: *x\n---\n", "a", 3)).toThrow(/alias/);
    expect(() =>
      editFrontmatter("---\na: &x 1\nb: *x\n---\n", { kind: "remove", key: "a" }),
    ).toThrow(/alias/);
    expect(editFrontmatter("---\na: &x 1\nb: *x\n---\n", { kind: "remove", key: "b" })).toBe(
      "---\na: &x 1\n---\n",
    );
  });

  it("appends a new key at the end of the frontmatter", () => {
    const out = set(NOTE, "status", "open");
    expect(out).toBe(NOTE.replace("aliases: [x, y]\n", "aliases: [x, y]\nstatus: open\n"));
  });

  it("quotes values that would change type", () => {
    const out = set("---\na: 1\n---\n", "a", "true");
    expect(splitFrontmatter(out).data["a"]).toBe("true");
    expect(splitFrontmatter(set(out, "b", "2024-01-02")).data["b"]).toBe("2024-01-02");
    expect(splitFrontmatter(set(out, "c", "")).data["c"]).toBe("");
  });

  it("writes checkboxes and numbers as such", () => {
    const out = set(set("---\na: 1\n---\n", "done", true), "n", 2.5);
    expect(splitFrontmatter(out).data).toEqual({ a: 1, done: true, n: 2.5 });
  });

  it("adds a key to an empty frontmatter", () => {
    expect(set("---\n---\nbody\n", "a", 1)).toBe("---\na: 1\n---\nbody\n");
  });

  it("creates the frontmatter of a note without one", () => {
    expect(set("# Title\n", "tags", ["x"])).toBe("---\ntags:\n  - x\n---\n# Title\n");
    expect(set("", "a", "b")).toBe("---\na: b\n---\n");
  });

  it("keeps CRLF and the byte order mark", () => {
    const out = set("﻿---\r\na: 1\r\nb: 2\r\n---\r\nbody\r\n", "c", ["x"]);
    expect(out).toBe("﻿---\r\na: 1\r\nb: 2\r\nc:\r\n  - x\r\n---\r\nbody\r\n");
    expect(set("# T\r\n", "a", 1)).toBe("---\r\na: 1\r\n---\r\n# T\r\n");
  });

  it("does not touch the body", () => {
    expect(set(NOTE, "count", 9).endsWith("---\n# Body\ntext\n")).toBe(true);
  });

  it("falls back to rewriting a flow mapping", () => {
    const out = set("---\n{a: 1, b: 2}\n---\n", "a", 3);
    expect(splitFrontmatter(out).data).toEqual({ a: 3, b: 2 });
  });

  it("refuses invalid frontmatter", () => {
    expect(() => set("---\na: [1\n---\n", "b", 1)).toThrow(/flow sequence/i);
    expect(() => set("---\n- a\n- b\n---\n", "b", 1)).toThrow(/mapping/);
  });
});

describe("editFrontmatter rename", () => {
  it("renames the key and keeps its value, position and comment", () => {
    expect(editFrontmatter(NOTE, { kind: "rename", from: "title", to: "name" })).toBe(
      NOTE.replace("title: Hello", "name: Hello"),
    );
  });

  it("renames a key with a block list", () => {
    const out = editFrontmatter(NOTE, { kind: "rename", from: "tags", to: "labels" });
    expect(out).toBe(NOTE.replace("tags:", "labels:"));
  });

  it("quotes a key that needs it", () => {
    const out = editFrontmatter("---\na: 1\n---\n", { kind: "rename", from: "a", to: "my key: x" });
    expect(splitFrontmatter(out).data).toEqual({ "my key: x": 1 });
  });

  it("refuses an existing name", () => {
    expect(() => editFrontmatter(NOTE, { kind: "rename", from: "title", to: "count" })).toThrow(
      /already exists/,
    );
  });

  it("ignores an unknown key", () => {
    expect(editFrontmatter(NOTE, { kind: "rename", from: "nope", to: "x" })).toBe(NOTE);
  });
});

describe("editFrontmatter remove", () => {
  it("removes a scalar line only", () => {
    expect(editFrontmatter(NOTE, { kind: "remove", key: "count" })).toBe(
      NOTE.replace("count: 3\n", ""),
    );
  });

  it("removes a block list with all its items", () => {
    expect(editFrontmatter(NOTE, { kind: "remove", key: "tags" })).toBe(
      NOTE.replace("tags:\n  - a\n  - b\n", ""),
    );
  });

  it("removes the last key and leaves an empty frontmatter", () => {
    expect(editFrontmatter("---\na: 1\n---\nbody\n", { kind: "remove", key: "a" })).toBe(
      "---\n---\nbody\n",
    );
  });

  it("removes the key before the closing fence without a final newline in the block", () => {
    expect(editFrontmatter("---\na: 1\nb: 2\n---\n", { kind: "remove", key: "b" })).toBe(
      "---\na: 1\n---\n",
    );
  });

  it("leaves a note without frontmatter and unknown keys alone", () => {
    expect(editFrontmatter("# T\n", { kind: "remove", key: "a" })).toBe("# T\n");
    expect(editFrontmatter(NOTE, { kind: "remove", key: "zzz" })).toBe(NOTE);
  });
});

describe("round trip", () => {
  it("setting every key to its own value changes nothing in the data", () => {
    let text = NOTE;
    const before = splitFrontmatter(text).data;
    for (const [k, v] of Object.entries(before)) text = set(text, k, v);
    expect(splitFrontmatter(text).data).toEqual(before);
    expect(text.endsWith("# Body\ntext\n")).toBe(true);
  });
});

describe("editFrontmatter move", () => {
  const move = (text: string, key: string, direction: -1 | 1) =>
    editFrontmatter(text, { kind: "move", key, direction });

  it("swaps the lines of a property with its neighbour and keeps the rest", () => {
    const text = "---\na: 1\nb:\n  - x\n  - y\nc: 3 # last\n---\nBody\n";
    expect(move(text, "b", -1)).toBe("---\nb:\n  - x\n  - y\na: 1\nc: 3 # last\n---\nBody\n");
    expect(move(text, "b", 1)).toBe("---\na: 1\nc: 3 # last\nb:\n  - x\n  - y\n---\nBody\n");
  });

  it("does nothing at either end or for an unknown key", () => {
    const text = "---\na: 1\nb: 2\n---\n";
    expect(move(text, "a", -1)).toBe(text);
    expect(move(text, "b", 1)).toBe(text);
    expect(move(text, "zz", 1)).toBe(text);
  });

  it("keeps CRLF line ends", () => {
    expect(move("---\r\na: 1\r\nb: 2\r\n---\r\n", "b", -1)).toBe("---\r\nb: 2\r\na: 1\r\n---\r\n");
  });

  it("reorders a flow mapping", () => {
    const out = move("---\n{a: 1, b: 2}\n---\n", "a", 1);
    expect(Object.keys(splitFrontmatter(out).data)).toEqual(["b", "a"]);
  });
});

describe("editFrontmatter move, comments and anchors", () => {
  const move = (text: string, key: string, direction: -1 | 1) =>
    editFrontmatter(text, { kind: "move", key, direction });

  it("moves the comment lines above a key with it and leaves trailing comments", () => {
    const text = "---\na: 1\n# about b\nb: 2\n# trailing\n---\n";
    expect(move(text, "b", -1)).toBe("---\n# about b\nb: 2\na: 1\n# trailing\n---\n");
    expect(move(text, "a", 1)).toBe("---\n# about b\nb: 2\na: 1\n# trailing\n---\n");
  });

  it("refuses to put an alias before its anchor", () => {
    const text = "---\na: &x 1\nb: *x\n---\n";
    expect(() => move(text, "b", -1)).toThrow(/alias/);
    expect(() => move(text, "a", 1)).toThrow(/alias/);
  });
});

describe("editFrontmatter numeric and boolean keys", () => {
  it.each([
    ["---\n{2024: a, b: 1}\n---\n", "2024", "---\n{ 2024: z, b: 1 }\n---\n"],
    ["---\n{true: a}\n---\n", "true", "---\n{ true: z }\n---\n"],
  ])("sets the existing key of a one-line mapping: %j", (text, key, out) => {
    expect(set(text, key, "z")).toBe(out);
  });

  it("keeps the quotes and the comment of a value in a one-line mapping", () => {
    expect(set("---\n{a: 'x', 2024: 1, # c\n b: 2}\n---\n", "2024", 5)).toBe(
      "---\n{\n  a: 'x',\n  2024: 5, # c\n  b: 2\n}\n---\n",
    );
    expect(set("---\n{a: 'x', b: 2}\n---\n", "a", "y")).toBe("---\n{ a: 'y', b: 2 }\n---\n");
  });

  it("renames, removes and moves the numeric key of a one-line mapping", () => {
    const text = "---\n{2024: a, b: 1}\n---\n";
    expect(editFrontmatter(text, { kind: "rename", from: "2024", to: "y" })).toBe(
      "---\n{ y: a, b: 1 }\n---\n",
    );
    expect(editFrontmatter(text, { kind: "remove", key: "2024" })).toBe("---\n{ b: 1 }\n---\n");
    expect(editFrontmatter(text, { kind: "move", key: "2024", direction: 1 })).toBe(
      "---\n{ b: 1, 2024: a }\n---\n",
    );
  });

  it("refuses a rename onto a numeric key of a one-line mapping", () => {
    expect(() =>
      editFrontmatter("---\n{2024: a, b: 1}\n---\n", { kind: "rename", from: "b", to: "2024" }),
    ).toThrow(/already exists/);
  });

  it.each([
    ["---\n2024: a\n---\n", "2024", "z", "---\n2024: z\n---\n"],
    ["---\ntrue: a # c\n---\n", "true", "z", "---\ntrue: z # c\n---\n"],
    ["---\n'a': x\n---\n", "a", "y", "---\n'a': y\n---\n"],
    ['---\n"b c": "x"\n---\n', "b c", "y", '---\n"b c": "y"\n---\n'],
    ["---\n2024:\n---\n", "2024", ["x"], "---\n2024:\n  - x\n---\n"],
    ["---\n2024: [a]\n---\n", "2024", ["a", "b"], "---\n2024: [a, b]\n---\n"],
  ])("keeps the key of a block mapping as written: %j", (text, key, value, out) => {
    expect(set(text, key, value)).toBe(out);
  });

  it("still edits a note whose one-line mapping already has two such keys", () => {
    // `2024` and `'2024'` both name the property "2024"; the edit adds no further one.
    expect(set("---\n{2024: a, '2024': b}\n---\n", "x", 1)).toBe(
      "---\n{ 2024: a, '2024': b, x: 1 }\n---\n",
    );
  });
});

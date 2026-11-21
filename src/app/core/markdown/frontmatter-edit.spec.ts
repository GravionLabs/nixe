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

  it("changes a flow list on its own line", () => {
    expect(set(NOTE, "aliases", ["z"])).toBe(NOTE.replace("aliases: [x, y]", "aliases:\n  - z"));
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

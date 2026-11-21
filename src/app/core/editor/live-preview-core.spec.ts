import { describe, expect, it } from "vitest";

import { disjoint, findBlocks, inlineMarks, sourceSpan, touches } from "./live-preview-core";

const at = (lines: string[]) => (n: number) => lines[n];

describe("findBlocks", () => {
  it("finds frontmatter, code, mermaid, math, table, callout and embeds", () => {
    const lines = [
      "---",
      "a: 1",
      "---",
      "text",
      "```ts",
      "| not | a table |",
      "```",
      "```mermaid",
      "graph TD",
      "```",
      "$$",
      "x^2",
      "$$",
      "| a | b |",
      "| - | - |",
      "| 1 | 2 |",
      "",
      "> [!note] Title",
      "> body",
      "![[Other]]",
      "![img](a.png)",
    ];
    expect(findBlocks(lines)).toEqual([
      { kind: "frontmatter", start: 0, end: 2 },
      { kind: "code", start: 4, end: 6 },
      { kind: "mermaid", start: 7, end: 9 },
      { kind: "math", start: 10, end: 12 },
      { kind: "table", start: 13, end: 15 },
      { kind: "callout", start: 17, end: 18 },
      { kind: "embed", start: 19, end: 19 },
      { kind: "embed", start: 20, end: 20 },
    ]);
  });

  it("closes an unterminated fence at the end of the note", () => {
    expect(findBlocks(["```", "a", "b"])).toEqual([{ kind: "code", start: 0, end: 2 }]);
  });

  it("takes a one-line math block and ignores a plain blockquote", () => {
    expect(findBlocks(["$$x$$", "> quote"])).toEqual([{ kind: "math", start: 0, end: 0 }]);
  });

  it("needs a delimiter row for a table", () => {
    expect(findBlocks(["a | b", "text"])).toEqual([]);
  });

  it("scans a large note quickly", () => {
    const lines = Array.from({ length: 50_000 }, (_, i) =>
      i % 10 === 0 ? "| a | b |" : i % 10 === 1 ? "| - | - |" : `line ${i} **bold**`,
    );
    const t = performance.now();
    const blocks = findBlocks(lines);
    expect(blocks.length).toBe(5000);
    expect(performance.now() - t).toBeLessThan(1000);
  });
});

describe("sourceSpan", () => {
  it("spans the paragraph up to the blank lines", () => {
    const l = ["a", "b", "", "c"];
    expect(sourceSpan(at(l), l.length, 1)).toEqual({ start: 0, end: 1 });
  });
  it("is one line for a heading, also next to text", () => {
    const l = ["# H", "text"];
    expect(sourceSpan(at(l), l.length, 0)).toEqual({ start: 0, end: 0 });
    expect(sourceSpan(at(l), l.length, 1)).toEqual({ start: 1, end: 1 });
  });
  it("is one list item with its continuation lines", () => {
    const l = ["- a", "  more", "- b"];
    expect(sourceSpan(at(l), l.length, 1)).toEqual({ start: 0, end: 1 });
    expect(sourceSpan(at(l), l.length, 2)).toEqual({ start: 2, end: 2 });
  });
  it("is the blank line itself", () => {
    const l = ["a", "", "b"];
    expect(sourceSpan(at(l), l.length, 1)).toEqual({ start: 1, end: 1 });
  });
});

describe("inlineMarks", () => {
  const hidden = (line: string) =>
    inlineMarks(line)
      .filter((m) => m.kind === "hide")
      .map((m) => line.slice(m.from, m.to));

  it("hides the heading marker", () => {
    expect(hidden("## Title")).toEqual(["## "]);
  });
  it("hides bold, italic, strike, highlight and code marks", () => {
    expect(hidden("**b** *i* ~~s~~ ==h== `c`")).toEqual(
      expect.arrayContaining(["**", "*", "~~", "==", "`"]),
    );
  });
  it("leaves the content of a code span alone", () => {
    expect(hidden("`**x**`")).toEqual(["`", "`"]);
  });
  it("hides the brackets and the target of a wikilink and a link", () => {
    expect(hidden("[[Note]]")).toEqual(["[[", "]]"]);
    expect(hidden("[[Note|Alias]]")).toEqual(["[[Note|", "]]"]);
    expect(hidden("[t](http://x)")).toEqual(["[", "](http://x)"]);
  });
  it("turns list markers into bullets and tasks into checkboxes", () => {
    expect(inlineMarks("- a")).toEqual([{ from: 0, to: 1, kind: "bullet" }]);
    const task = inlineMarks("- [x] done");
    expect(task.find((m) => m.kind === "checkbox")).toMatchObject({
      from: 2,
      to: 5,
      checked: true,
    });
    expect(task.find((m) => m.kind === "hide")).toMatchObject({ from: 0, to: 1 });
  });
  it("does not treat snake_case or 2*3*4 as emphasis", () => {
    expect(hidden("snake_case_name")).toEqual([]);
    expect(hidden("2 * 3 * 4")).toEqual([]);
  });
});

describe("disjoint / touches", () => {
  it("drops overlapping marks", () => {
    const m = disjoint([
      { from: 0, to: 3, kind: "hide" },
      { from: 2, to: 4, kind: "hide" },
      { from: 4, to: 5, kind: "hide" },
    ]);
    expect(m.map((x) => x.from)).toEqual([0, 4]);
  });
  it("counts the ends of a block as touching", () => {
    expect(touches(5, 5, 5, 9)).toBe(true);
    expect(touches(9, 9, 5, 9)).toBe(true);
    expect(touches(4, 4, 5, 9)).toBe(false);
    expect(touches(3, 12, 5, 9)).toBe(true);
  });
});

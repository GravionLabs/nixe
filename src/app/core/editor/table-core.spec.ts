import { describe, expect, it } from "vitest";

import {
  deleteColumn,
  deleteRow,
  escapeCell,
  formatTable,
  insertColumn,
  insertRow,
  parseTable,
  setAlign,
  setCell,
  unescapeCell,
} from "./table-core";

describe("parseTable", () => {
  it("reads header, alignments and body rows", () => {
    const t = parseTable(["| a | b | c |", "| :-- | :-: | --: |", "| 1 | 2 | 3 |"]);
    expect(t.rows).toEqual([
      ["a", "b", "c"],
      ["1", "2", "3"],
    ]);
    expect(t.aligns).toEqual(["left", "center", "right"]);
  });

  it("accepts rows without outer pipes", () => {
    const t = parseTable(["a | b", "- | -", "1 | 2"]);
    expect(t.rows).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
    expect(t.aligns).toEqual([null, null]);
  });

  it("pads uneven rows to the widest one", () => {
    const t = parseTable(["| a | b |", "| - | - |", "| 1 |", "| 1 | 2 | 3 |"]);
    expect(t.rows).toEqual([
      ["a", "b", ""],
      ["1", "", ""],
      ["1", "2", "3"],
    ]);
    expect(t.aligns).toHaveLength(3);
  });

  it("keeps an escaped pipe in the cell and a trailing escaped pipe", () => {
    const t = parseTable(["| a \\| b | c |", "| - | - |", "| x | y \\|"]);
    expect(t.rows[0]).toEqual(["a | b", "c"]);
    expect(t.rows[1]).toEqual(["x", "y |"]);
  });
});

describe("escaping", () => {
  it("escapes pipes and flattens line breaks", () => {
    expect(escapeCell("a|b\nc")).toBe("a\\|b c");
    expect(unescapeCell("a\\|b")).toBe("a|b");
  });
});

describe("formatTable", () => {
  it("aligns the pipes and writes the alignment row", () => {
    const t = parseTable(["| name | n |", "| :-- | --: |", "| a | 100 |"]);
    expect(formatTable(t)).toEqual(["| name |   n |", "| :--- | --: |", "| a    | 100 |"]);
  });

  it("centres and escapes", () => {
    const t = setAlign(parseTable(["| a |", "| - |", "| x |"]), 0, "center");
    expect(formatTable(setCell(t, 1, 0, "p|q"))).toEqual(["|  a   |", "| :--: |", "| p\\|q |"]);
  });

  it("round-trips a formatted table", () => {
    const lines = ["| a   | b   |", "| --- | --- |", "| 1   | 2   |"];
    expect(formatTable(parseTable(lines))).toEqual(lines);
  });
});

describe("table edits", () => {
  const base = parseTable(["| a | b |", "| :-- | --: |", "| 1 | 2 |"]);

  it("inserts rows below the header and at the end, never above the header", () => {
    expect(insertRow(base, 1).rows).toEqual([
      ["a", "b"],
      ["", ""],
      ["1", "2"],
    ]);
    expect(insertRow(base, 2).rows).toEqual([
      ["a", "b"],
      ["1", "2"],
      ["", ""],
    ]);
    expect(insertRow(base, 0).rows[1]).toEqual(["", ""]);
  });

  it("deletes body rows only", () => {
    expect(deleteRow(base, 1).rows).toEqual([["a", "b"]]);
    expect(deleteRow(base, 0)).toBe(base);
  });

  it("inserts and deletes columns with their alignment", () => {
    const wider = insertColumn(base, 1);
    expect(wider.rows).toEqual([
      ["a", "", "b"],
      ["1", "", "2"],
    ]);
    expect(wider.aligns).toEqual(["left", null, "right"]);
    const narrower = deleteColumn(base, 0);
    expect(narrower.rows).toEqual([["b"], ["2"]]);
    expect(narrower.aligns).toEqual(["right"]);
    expect(deleteColumn(narrower, 0)).toBe(narrower);
  });

  it("sets alignment of one column", () => {
    expect(setAlign(base, 0, null).aligns).toEqual([null, "right"]);
  });
});

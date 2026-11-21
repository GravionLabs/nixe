/** Pure model of a Markdown table for cell editing in the live preview (#378); no CodeMirror imports. */

export type Align = "left" | "center" | "right" | null;

/** A table as cells: row 0 is the header. Cell texts are unescaped (`|` is a plain pipe). */
export interface TableModel {
  readonly aligns: readonly Align[];
  readonly rows: readonly (readonly string[])[];
}

/** Splits a table row at the pipes that are not escaped; the outer pipes are optional. */
function splitRow(line: string): string[] {
  let text = line.trim();
  if (text.startsWith("|")) text = text.slice(1);
  if (text.endsWith("|") && !text.endsWith("\\|")) text = text.slice(0, -1);
  const cells: string[] = [];
  let cur = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\\" && text[i + 1] === "|") {
      cur += "\\|";
      i++;
    } else if (ch === "|") {
      cells.push(cur);
      cur = "";
    } else cur += ch;
  }
  cells.push(cur);
  return cells.map((c) => unescapeCell(c.trim()));
}

/** A cell as it is written: `|` escaped, line breaks as spaces. */
export function escapeCell(text: string): string {
  return text.replace(/\r?\n/g, " ").replace(/\|/g, "\\|");
}

/** The text of a written cell: `\|` is a pipe. */
export function unescapeCell(text: string): string {
  return text.replace(/\\\|/g, "|");
}

function alignOf(cell: string): Align {
  const t = cell.trim();
  const left = t.startsWith(":");
  const right = t.endsWith(":");
  return left && right ? "center" : left ? "left" : right ? "right" : null;
}

/**
 * Parses the lines of a table block (header, delimiter row, body rows). Uneven rows are padded with
 * empty cells to the widest row, so no cell is lost.
 */
export function parseTable(lines: readonly string[]): TableModel {
  const header = splitRow(lines[0] ?? "");
  const delimiter = splitRow(lines[1] ?? "").map(alignOf);
  const body = lines.slice(2).map(splitRow);
  const width = Math.max(1, header.length, delimiter.length, ...body.map((r) => r.length));
  const pad = <T>(row: readonly T[], fill: T): T[] =>
    Array.from({ length: width }, (_, i) => (i < row.length ? row[i] : fill));
  return {
    aligns: pad<Align>(delimiter, null),
    rows: [header, ...body].map((r) => pad(r, "")),
  };
}

function delimiterCell(align: Align, width: number): string {
  const inner = Math.max(3, width);
  if (align === "center") return `:${"-".repeat(inner - 2)}:`;
  if (align === "left") return `:${"-".repeat(inner - 1)}`;
  if (align === "right") return `${"-".repeat(inner - 1)}:`;
  return "-".repeat(inner);
}

function padCell(text: string, width: number, align: Align): string {
  const gap = Math.max(0, width - text.length);
  if (align === "right") return " ".repeat(gap) + text;
  if (align === "center") {
    const left = Math.floor(gap / 2);
    return " ".repeat(left) + text + " ".repeat(gap - left);
  }
  return text + " ".repeat(gap);
}

/** The lines of the table with aligned pipes. */
export function formatTable(model: TableModel): string[] {
  const escaped = model.rows.map((r) => r.map(escapeCell));
  const widths = model.aligns.map((_, c) => Math.max(3, ...escaped.map((r) => r[c].length)));
  const row = (cells: readonly string[]) =>
    `| ${cells.map((t, c) => padCell(t, widths[c], model.aligns[c])).join(" | ")} |`;
  const delimiter = `| ${model.aligns.map((a, c) => delimiterCell(a, widths[c])).join(" | ")} |`;
  return [row(escaped[0]), delimiter, ...escaped.slice(1).map(row)];
}

export function setCell(model: TableModel, row: number, col: number, text: string): TableModel {
  return {
    aligns: model.aligns,
    rows: model.rows.map((r, i) => (i === row ? r.map((c, j) => (j === col ? text : c)) : r)),
  };
}

/** Inserts an empty body row at `at` (1 = right below the header). */
export function insertRow(model: TableModel, at: number): TableModel {
  const index = Math.min(Math.max(1, at), model.rows.length);
  const rows = [...model.rows];
  rows.splice(
    index,
    0,
    model.aligns.map(() => ""),
  );
  return { aligns: model.aligns, rows };
}

/** The header cannot be deleted; a table keeps at least its header. */
export function deleteRow(model: TableModel, row: number): TableModel {
  if (row <= 0 || row >= model.rows.length) return model;
  return { aligns: model.aligns, rows: model.rows.filter((_, i) => i !== row) };
}

/** Inserts an empty column at `at` (0 = left of the first). */
export function insertColumn(model: TableModel, at: number): TableModel {
  const index = Math.min(Math.max(0, at), model.aligns.length);
  const put = <T>(row: readonly T[], value: T): T[] => {
    const next = [...row];
    next.splice(index, 0, value);
    return next;
  };
  return { aligns: put(model.aligns, null), rows: model.rows.map((r) => put(r, "")) };
}

/** A table keeps at least one column. */
export function deleteColumn(model: TableModel, col: number): TableModel {
  if (model.aligns.length <= 1 || col < 0 || col >= model.aligns.length) return model;
  const drop = <T>(row: readonly T[]): T[] => row.filter((_, j) => j !== col);
  return { aligns: drop(model.aligns), rows: model.rows.map(drop) };
}

export function setAlign(model: TableModel, col: number, align: Align): TableModel {
  return { aligns: model.aligns.map((a, j) => (j === col ? align : a)), rows: model.rows };
}

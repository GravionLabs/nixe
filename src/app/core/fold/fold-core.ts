/** A foldable part of a note. Lines are 1-based. */
export interface FoldRange {
  /** The line that stays visible and carries the gutter marker. */
  line: number;
  /** The last hidden line. */
  endLine: number;
  kind: "frontmatter" | "heading" | "list";
}

const FENCE = /^[ \t]*(`{3,}|~{3,})/;
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]|$)/;
const LIST_ITEM = /^([ \t]*)(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$)/;

function indentOf(text: string): number {
  let width = 0;
  for (const ch of text) {
    if (ch === " ") width += 1;
    else if (ch === "\t") width += 4 - (width % 4);
    else break;
  }
  return width;
}

/** The last line of the frontmatter (the closing `---`), 1-based; null when the note has none. */
export function frontmatterEnd(lines: readonly string[]): number | null {
  if (lines[0]?.trimEnd() !== "---") return null;
  for (let i = 1; i < lines.length; i++) {
    const t = lines[i]!.trimEnd();
    if (t === "---" || t === "...") return i + 1;
  }
  return null;
}

/**
 * Everything of a note that can fold: the frontmatter, headings (down to the next heading of the
 * same or a higher level) and list items (their deeper lines). Code fences are skipped; trailing
 * blank lines stay visible. A range with nothing to hide is left out. Ordered by `line`.
 */
export function foldRanges(text: string): FoldRange[] {
  const lines = text.split(/\r?\n/);
  const ranges: FoldRange[] = [];
  const fm = frontmatterEnd(lines);
  if (fm !== null && fm > 2) ranges.push({ line: 1, endLine: fm, kind: "frontmatter" });

  // Headings and list items outside fenced code, with the indent of each line.
  const infos: { level: number; item: boolean; indent: number; blank: boolean; code: boolean }[] =
    [];
  let fence: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i]!;
    const info = {
      level: 0,
      item: false,
      indent: indentOf(t),
      blank: t.trim() === "",
      code: false,
    };
    if (fm !== null && i < fm) {
      info.code = true;
    } else if (fence !== null) {
      info.code = true;
      const close = FENCE.exec(t);
      if (
        close &&
        close[1]![0] === fence[0] &&
        close[1]!.length >= fence.length &&
        t.trim() === close[1]
      )
        fence = null;
    } else {
      const open = FENCE.exec(t);
      if (open) {
        fence = open[1]!;
        info.code = true;
      } else {
        const h = HEADING.exec(t);
        if (h) info.level = h[1]!.length;
        else if (LIST_ITEM.test(t)) info.item = true;
      }
    }
    infos.push(info);
  }

  const lastContent = (from: number, to: number): number => {
    let end = to;
    while (end > from && infos[end]!.blank) end--;
    return end;
  };

  for (let i = 0; i < infos.length; i++) {
    const info = infos[i]!;
    if (info.level > 0) {
      let j = i + 1;
      while (j < infos.length && !(infos[j]!.level > 0 && infos[j]!.level <= info.level)) j++;
      const end = lastContent(i, j - 1);
      if (end > i) ranges.push({ line: i + 1, endLine: end + 1, kind: "heading" });
    } else if (info.item) {
      let end = i;
      for (let j = i + 1; j < infos.length; j++) {
        const next = infos[j]!;
        if (next.blank) continue;
        if (next.level > 0 || next.indent <= info.indent) break;
        end = j;
      }
      if (end > i) ranges.push({ line: i + 1, endLine: end + 1, kind: "list" });
    }
  }
  return ranges;
}

/**
 * The block indexes that a folded heading hides. `levels[i]` is the heading level (1 to 6) of the
 * i-th block of the rendered note, 0 for any other block; `folded` holds the indexes of the folded
 * headings. A folded heading hides the blocks up to the next heading of the same or a higher level.
 */
export function hiddenBlocks(levels: readonly number[], folded: ReadonlySet<number>): Set<number> {
  const hidden = new Set<number>();
  for (const i of folded) {
    const level = levels[i];
    if (!level) continue;
    for (let j = i + 1; j < levels.length; j++) {
      const next = levels[j]!;
      if (next > 0 && next <= level) break;
      hidden.add(j);
    }
  }
  return hidden;
}

/** Folded start lines of every note by path, as kept in the app data directory. */
export type FoldState = Record<string, number[]>;

/** Reads the stored state; text that is damaged or has the wrong shape gives an empty state. */
export function parseFoldState(text: string | null): FoldState {
  if (!text) return {};
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return {};
  }
  if (typeof json !== "object" || json === null || Array.isArray(json)) return {};
  const state: FoldState = {};
  for (const [path, value] of Object.entries(json)) {
    if (!Array.isArray(value)) continue;
    const lines = normalizeLines(value.filter((v): v is number => typeof v === "number"));
    if (lines.length) state[path] = lines;
  }
  return state;
}

/** Sorted, unique, positive whole line numbers. */
export function normalizeLines(lines: readonly number[]): number[] {
  return [...new Set(lines.filter((n) => Number.isInteger(n) && n > 0))].sort((a, b) => a - b);
}

export function serializeFoldState(state: FoldState): string {
  return JSON.stringify(state);
}

/** Pure line analysis for the editor decorations (#59); no CodeMirror imports. */

export interface Range {
  readonly from: number;
  readonly to: number;
}

export interface Checkbox extends Range {
  readonly checked: boolean;
}

/** Offsets (relative to the line) of the `**` markers of each closed `**bold**` pair. */
export function boldMarkers(line: string): Range[] {
  const out: Range[] = [];
  const re = /\*\*(?=\S)(.+?)(?<=\S)\*\*/g;
  for (const m of line.matchAll(re)) {
    const start = m.index;
    const end = start + m[0].length;
    out.push({ from: start, to: start + 2 }, { from: end - 2, to: end });
  }
  return out;
}

/** The `[ ]` / `[x]` of a task list item, offsets relative to the line. */
export function checkbox(line: string): Checkbox | null {
  const m = /^(\s*[-*+]\s)\[([ xX])\](?=\s|$)/.exec(line);
  if (!m) return null;
  const from = m[1].length;
  return { from, to: from + 3, checked: m[2] !== " " };
}

/** Replacement text that flips a checkbox. */
export function toggledCheckbox(checked: boolean): string {
  return checked ? "[ ]" : "[x]";
}

export type Rating = "ok" | "annoying" | "blocker";

export const CHECKLIST_ITEMS = [
  "typing",
  "autocorrect",
  "dictation",
  "selection handles",
  "copy and paste",
  "scrolling a 2000-line note",
  "keyboard show and hide",
  "undo",
  "external keyboard",
  "hide ** outside the cursor line",
  "checkbox widget",
] as const;

/** The test result as markdown for the issue comment. */
export function checklistMarkdown(
  ratings: Readonly<Record<string, Rating | undefined>>,
  notes: Readonly<Record<string, string | undefined>> = {},
): string {
  const lines = ["| item | rating | note |", "| --- | --- | --- |"];
  for (const item of CHECKLIST_ITEMS) {
    const note = (notes[item] ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
    lines.push(`| ${item} | ${ratings[item] ?? "untested"} | ${note} |`);
  }
  return lines.join("\n");
}

export const FONT_DEFAULT = 14;
const FONT_MIN = 8;
const FONT_MAX = 28;

/** A usable editor font size in px: whole number within bounds, default for anything else. */
export function clampFontSize(value: unknown): number {
  const n = typeof value === "string" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isFinite(n)) return FONT_DEFAULT;
  return Math.min(FONT_MAX, Math.max(FONT_MIN, Math.round(n)));
}

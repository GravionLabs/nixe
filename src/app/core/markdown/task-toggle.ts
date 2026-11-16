/** A task list item: optional quote markers, indent, list marker, then `[ ]`, `[x]` or `[X]`. */
const TASK_LINE = /^((?:\s*>)*\s*(?:[-*+]|\d+[.)])\s+\[)([ xX])(\])/;

/**
 * Sets the task on the 0-based `line` to `checked` and returns the new text.
 * Returns null when the line is no `[ ]`/`[x]` task (`- [/]` and other markers stay as they are),
 * is outside the text, or is already in that state. Only the one character changes, so line endings
 * and the rest of the line are kept.
 */
export function setTaskState(text: string, line: number, checked: boolean): string | null {
  if (!Number.isInteger(line) || line < 0) return null;
  const lines = text.split("\n");
  const current = lines[line];
  if (current === undefined) return null;
  const match = TASK_LINE.exec(current);
  if (!match) return null;
  const mark = checked ? "x" : " ";
  if (match[2] === mark || (checked && match[2] === "X")) return null;
  lines[line] = match[1] + mark + current.slice(match[1].length + 1);
  return lines.join("\n");
}

/**
 * The 0-based line at which `part` starts in `text`, for an embed that shows only a section of the
 * note. `part` is a slice of the note's lines (the last line may be shortened); null when not found.
 */
export function partLineOffset(text: string, part: string): number | null {
  const lines = text.split("\n").map((l) => l.trimEnd());
  const wanted = part.split(/\r?\n/).map((l) => l.trimEnd());
  for (let i = 0; i + wanted.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < wanted.length && ok; j++) {
      const have = lines[i + j]!;
      ok = j === wanted.length - 1 ? have.startsWith(wanted[j]!) : have === wanted[j];
    }
    if (ok) return i;
  }
  return null;
}

/** Pure block and inline analysis of the live preview (#243); no CodeMirror imports. */
import { parseEmbed } from "../markdown/embed";

export type BlockKind =
  | "frontmatter"
  | "code"
  | "mermaid"
  | "math"
  | "table"
  | "callout"
  | "embed"
  /** A ```base fence. */
  | "base"
  /** A line that is only the embed of a `.base` file. */
  | "base-embed";

/** A multi-line part of the note. Lines are 0-based and inclusive. */
export interface Block {
  readonly kind: BlockKind;
  readonly start: number;
  readonly end: number;
}

/** Kinds that are drawn as a widget while the cursor is elsewhere. */
export const WIDGET_KINDS: ReadonlySet<BlockKind> = new Set([
  "mermaid",
  "math",
  "table",
  "callout",
  "embed",
  "base",
  "base-embed",
]);

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)/;
const TABLE_DELIMITER = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;
const CALLOUT = /^ {0,3}>\s*\[![^\]\s]+\][+-]?/;
const EMBED = /^\s*!(\[\[[^\]\n]+\]\]|\[[^\]\n]*\]\([^)\n]+\))\s*$/;
const WIKI_EMBED = /^\s*!\[\[([^[\]\n]+)\]\]\s*$/;
const FENCE_KINDS: ReadonlyMap<string, BlockKind> = new Map([
  ["mermaid", "mermaid"],
  ["base", "base"],
]);

/** Where a base block comes from: the YAML of a fence, or the target of an embed. */
export type BaseOrigin = { source: string } | { embed: string };

/** The origin of a `base` or `base-embed` block, read from its source as the reading view does. */
export function baseOrigin(text: string, kind: "base" | "base-embed"): BaseOrigin {
  if (kind === "base-embed") {
    const inner = WIKI_EMBED.exec(text)?.[1] ?? "";
    return { embed: parseEmbed(inner)?.target ?? "" };
  }
  const [open = "", ...lines] = text.split("\n");
  const indent = open.length - open.trimStart().length;
  const marker = FENCE.exec(open)?.[1] ?? "```";
  if (closingFence(marker).test(lines.at(-1) ?? "")) lines.pop();
  // The lines lose the indent of the opening fence.
  const strip = new RegExp(`^ {0,${indent}}`);
  return { source: lines.map((line) => `${line.replace(strip, "")}\n`).join("") };
}

function closingFence(marker: string): RegExp {
  return new RegExp(`^ {0,3}${marker[0]}{${marker.length},}\\s*$`);
}

/** Fenced code, math, tables, callouts, embeds and the frontmatter of a note, in document order. */
export function findBlocks(lines: readonly string[]): Block[] {
  const blocks: Block[] = [];
  let i = 0;
  if (lines[0]?.trimEnd() === "---") {
    for (let j = 1; j < lines.length; j++) {
      const t = lines[j].trimEnd();
      if (t === "---" || t === "...") {
        blocks.push({ kind: "frontmatter", start: 0, end: j });
        i = j + 1;
        break;
      }
    }
  }
  while (i < lines.length) {
    const line = lines[i];
    const fence = FENCE.exec(line);
    if (fence) {
      const marker = fence[1];
      let end = lines.length - 1;
      const close = closingFence(marker);
      for (let j = i + 1; j < lines.length; j++) {
        if (close.test(lines[j])) {
          end = j;
          break;
        }
      }
      const lang = fence[2].toLowerCase();
      blocks.push({ kind: FENCE_KINDS.get(lang) ?? "code", start: i, end });
      i = end + 1;
      continue;
    }
    if (/^\s*\$\$/.test(line)) {
      const rest = line.trim().slice(2);
      let end = i;
      if (!rest.includes("$$")) {
        end = lines.length - 1;
        for (let j = i + 1; j < lines.length; j++) {
          if (lines[j].includes("$$")) {
            end = j;
            break;
          }
        }
      }
      blocks.push({ kind: "math", start: i, end });
      i = end + 1;
      continue;
    }
    if (line.includes("|") && lines[i + 1]?.includes("|") && TABLE_DELIMITER.test(lines[i + 1])) {
      let end = i + 1;
      while (end + 1 < lines.length && lines[end + 1].trim() !== "" && lines[end + 1].includes("|"))
        end++;
      blocks.push({ kind: "table", start: i, end });
      i = end + 1;
      continue;
    }
    if (CALLOUT.test(line)) {
      let end = i;
      while (end + 1 < lines.length && /^ {0,3}>/.test(lines[end + 1])) end++;
      blocks.push({ kind: "callout", start: i, end });
      i = end + 1;
      continue;
    }
    if (EMBED.test(line)) {
      const wiki = WIKI_EMBED.exec(line);
      const base = wiki && parseEmbed(wiki[1])?.kind === "base";
      blocks.push({ kind: base ? "base-embed" : "embed", start: i, end: i });
    }
    i++;
  }
  return blocks;
}

const LIST_ITEM = /^\s*([-*+]|\d+[.)])\s/;
const HEADING = /^ {0,3}#{1,6}(\s|$)/;

/**
 * The lines (0-based, inclusive) that show their Markdown while the cursor is on `line`:
 * a heading is one line, a list item runs to the next item, any other text to the blank lines.
 */
export function sourceSpan(
  lineAt: (n: number) => string,
  count: number,
  line: number,
): { start: number; end: number } {
  if (HEADING.test(lineAt(line))) return { start: line, end: line };
  const blank = (n: number) => lineAt(n).trim() === "";
  if (blank(line)) return { start: line, end: line };
  let start = line;
  while (start > 0 && !blank(start - 1) && !HEADING.test(lineAt(start - 1))) {
    if (LIST_ITEM.test(lineAt(start))) break;
    start--;
  }
  let end = line;
  while (end + 1 < count && !blank(end + 1) && !HEADING.test(lineAt(end + 1))) {
    if (LIST_ITEM.test(lineAt(end + 1))) break;
    end++;
  }
  return { start, end };
}

/** How a part of a line is drawn: hidden, or replaced by a bullet. */
export interface Mark {
  readonly from: number;
  readonly to: number;
  readonly kind: "hide" | "bullet" | "checkbox";
  readonly checked?: boolean;
}

/** Replaces every character of the code spans by a space, so no later pattern matches inside. */
function maskCode(line: string): { masked: string; marks: Mark[] } {
  const marks: Mark[] = [];
  let masked = line;
  for (const m of line.matchAll(/(`+)(?!`)(.+?)(?<!`)\1(?!`)/g)) {
    const start = m.index;
    const tick = m[1].length;
    marks.push(
      { from: start, to: start + tick, kind: "hide" },
      { from: start + m[0].length - tick, to: start + m[0].length, kind: "hide" },
    );
    masked = masked.slice(0, start) + " ".repeat(m[0].length) + masked.slice(start + m[0].length);
  }
  return { masked, marks };
}

/** The syntax characters of one line that the live preview hides; offsets are relative to the line. */
export function inlineMarks(line: string): Mark[] {
  const marks: Mark[] = [];
  const heading = /^( {0,3}#{1,6})(\s+)/.exec(line);
  if (heading) marks.push({ from: 0, to: heading[0].length, kind: "hide" });

  const task = /^(\s*)([-*+])(\s)\[([ xX])\](?=\s|$)/.exec(line);
  if (task) {
    const at = task[1].length;
    marks.push(
      { from: at, to: at + 1, kind: "hide" },
      { from: at + 2, to: at + 5, kind: "checkbox", checked: task[4] !== " " },
    );
  } else {
    const bullet = /^(\s*)([-*+])(?=\s)/.exec(line);
    if (bullet) marks.push({ from: bullet[1].length, to: bullet[1].length + 1, kind: "bullet" });
  }

  const { masked, marks: code } = maskCode(line);
  marks.push(...code);

  const pair = (re: RegExp, width: number) => {
    for (const m of masked.matchAll(re)) {
      const end = m.index + m[0].length;
      marks.push(
        { from: m.index, to: m.index + width, kind: "hide" },
        { from: end - width, to: end, kind: "hide" },
      );
    }
  };
  pair(/\*\*(?=\S)(.+?)(?<=\S)\*\*/g, 2);
  pair(/(?<![\w_])__(?=\S)(.+?)(?<=\S)__(?![\w_])/g, 2);
  pair(/~~(?=\S)(.+?)(?<=\S)~~/g, 2);
  pair(/==(?=\S)(.+?)(?<=\S)==/g, 2);
  pair(/(?<![*\w])\*(?=[^\s*])([^*]+?)(?<=[^\s*])\*(?![*\w])/g, 1);
  pair(/(?<![\w_])_(?=[^\s_])([^_]+?)(?<=[^\s_])_(?![\w_])/g, 1);

  for (const m of masked.matchAll(/\[\[([^\]\n|]+)(\|)?([^\]\n]*)\]\]/g)) {
    const end = m.index + m[0].length;
    const aliasAt = m[2] ? m.index + 2 + m[1].length + 1 : m.index + 2;
    marks.push(
      { from: m.index, to: aliasAt, kind: "hide" },
      { from: end - 2, to: end, kind: "hide" },
    );
  }
  for (const m of masked.matchAll(/(?<!!)\[([^\]\n]+)\]\(([^)\n]+)\)/g)) {
    const end = m.index + m[0].length;
    marks.push(
      { from: m.index, to: m.index + 1, kind: "hide" },
      { from: m.index + 1 + m[1].length, to: end, kind: "hide" },
    );
  }
  return marks.filter((m) => m.to > m.from).sort((a, b) => a.from - b.from || a.to - b.to);
}

/** Drops marks that overlap an earlier one, so they can be added to a range set in order. */
export function disjoint(marks: readonly Mark[]): Mark[] {
  const out: Mark[] = [];
  let end = -1;
  for (const m of marks) {
    if (m.from < end) continue;
    out.push(m);
    end = m.to;
  }
  return out;
}

/** True when a selection range `[from, to]` touches the block `[blockFrom, blockTo]` (ends included). */
export function touches(from: number, to: number, blockFrom: number, blockTo: number): boolean {
  return from <= blockTo && to >= blockFrom;
}

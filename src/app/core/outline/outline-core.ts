/** Headings of a note as a tree, and the heading at a scroll position. No Angular, no DOM. */

export interface OutlineHeading {
  level: number;
  text: string;
  /** 1-based source line. */
  line: number;
}

export interface OutlineNode extends OutlineHeading {
  /** Position of the heading in document order; matches `currentHeading`. */
  index: number;
  children: OutlineNode[];
}

/** The text of a heading without its inline Markdown markers (links, emphasis, code). */
function plainText(text: string): string {
  return text
    .replace(/!?\[\[([^\]|]*?)(?:\|([^\]]*))?\]\]/g, (_m, target: string, alias?: string) => alias ?? target)
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`~]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** The ATX headings of a note in order, outside frontmatter and fenced code blocks. */
export function outlineOf(text: string): OutlineHeading[] {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  let i = 0;
  if (lines[0]?.trim() === "---") {
    const end = lines.findIndex((l, n) => n > 0 && /^(---|\.\.\.)\s*$/.test(l));
    if (end > 0) i = end + 1;
  }
  const out: OutlineHeading[] = [];
  let fence: { char: string; size: number } | null = null;
  for (; i < lines.length; i++) {
    const line = lines[i]!;
    const f = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (f) {
      const char = f[1]![0]!;
      const size = f[1]!.length;
      if (fence === null) fence = { char, size };
      else if (fence.char === char && size >= fence.size && /^ {0,3}[`~]+\s*$/.test(line)) fence = null;
      continue;
    }
    if (fence !== null) continue;
    const m = /^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/.exec(line);
    const label = m ? plainText(m[2]!) : "";
    if (m && label) out.push({ level: m[1]!.length, text: label, line: i + 1 });
  }
  return out;
}

/** Nests the headings by level; a heading becomes the child of the nearest previous one with a lower level. */
export function buildOutline(headings: readonly OutlineHeading[]): OutlineNode[] {
  const roots: OutlineNode[] = [];
  const stack: OutlineNode[] = [];
  headings.forEach((h, index) => {
    const node: OutlineNode = { ...h, index, children: [] };
    while (stack.length > 0 && stack[stack.length - 1]!.level >= node.level) stack.pop();
    const parent = stack[stack.length - 1];
    (parent ? parent.children : roots).push(node);
    stack.push(node);
  });
  return roots;
}

/**
 * Index of the heading the reader is in: the last one that starts at or above `topLine` (1-based).
 * -1 before the first heading or without a position.
 */
export function currentHeading(headings: readonly OutlineHeading[], topLine: number | null): number {
  if (topLine === null) return -1;
  let current = -1;
  for (let i = 0; i < headings.length; i++) {
    if (headings[i]!.line <= topLine) current = i;
    else break;
  }
  return current;
}

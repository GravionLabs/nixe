import { splitFrontmatter } from "./frontmatter";
import { extname, isMarkdownPath } from "./paths";
import { parseWikilinkTarget } from "./wikilink-resolver";

const IMAGE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".svg",
  ".webp",
  ".bmp",
  ".avif",
]);

export type EmbedKind = "note" | "image" | "file";

export interface Embed {
  /** Link target without the size, e.g. `Note#Heading` or `image.png`. */
  target: string;
  kind: EmbedKind;
  width: number | null;
  height: number | null;
}

/** Parses the inside of `![[…]]`: `Note#Heading`, `image.png|300`, `image.png|300x200`. */
export function parseEmbed(inner: string): Embed | null {
  const parts = inner.split("|").map((p) => p.trim());
  const target = parts[0];
  if (!target) return null;
  const { note } = parseWikilinkTarget(target);
  const ext = extname(note);
  const kind: EmbedKind = IMAGE_EXTENSIONS.has(ext)
    ? "image"
    : !ext || isMarkdownPath(note)
      ? "note"
      : "file";
  let width: number | null = null;
  let height: number | null = null;
  const size = /^(\d+)(?:x(\d+))?$/.exec(parts[parts.length - 1] ?? "");
  if (parts.length > 1 && size) {
    width = Number(size[1]);
    height = size[2] ? Number(size[2]) : null;
  }
  return { target, kind, width, height };
}

const HEADING_RE = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const FENCE_RE = /^ {0,3}(```|~~~)/;

/** Lines of `body` that are outside fenced code. */
function proseFlags(lines: string[]): boolean[] {
  let fence: string | null = null;
  return lines.map((line) => {
    const m = FENCE_RE.exec(line);
    if (m) {
      if (fence === null) fence = m[1];
      else if (m[1] === fence) fence = null;
      return false;
    }
    return fence === null;
  });
}

/** The section under `heading` (heading line included), up to the next heading of the same or a higher level. */
export function extractHeadingSection(text: string, heading: string): string | null {
  return headingSectionAt(text, heading)?.text ?? null;
}

/** A shown part of a note and the 0-based line of the note it starts on. */
export interface NotePart {
  text: string;
  start: number;
}

export function headingSectionAt(text: string, heading: string): NotePart | null {
  const lines = splitFrontmatter(text).body.split(/\r?\n/);
  const prose = proseFlags(lines);
  const wanted = heading.trim().toLowerCase();
  let start = -1;
  let level = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = prose[i] ? HEADING_RE.exec(lines[i]) : null;
    if (!m) continue;
    if (start < 0) {
      if (m[2].trim().toLowerCase() === wanted) {
        start = i;
        level = m[1].length;
      }
    } else if (m[1].length <= level) {
      return { text: lines.slice(start, i).join("\n").trimEnd(), start };
    }
  }
  return start < 0 ? null : { text: lines.slice(start).join("\n").trimEnd(), start };
}

/** The paragraph (or list item) that ends with `^id`, without the marker. */
export function extractBlock(text: string, id: string): string | null {
  return blockAt(text, id)?.text ?? null;
}

export function blockAt(text: string, id: string): NotePart | null {
  const lines = splitFrontmatter(text).body.split(/\r?\n/);
  const prose = proseFlags(lines);
  const marker = new RegExp(`\\s\\^${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`);
  const own = new RegExp(`^\\^${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`);
  for (let i = 0; i < lines.length; i++) {
    if (!prose[i]) continue;
    if (own.test(lines[i])) {
      // A marker on its own line refers to the block before it.
      let s = i - 1;
      while (s >= 0 && lines[s].trim() === "") s--;
      let b = s;
      while (b > 0 && lines[b - 1].trim() !== "" && !HEADING_RE.test(lines[b - 1])) b--;
      return s < 0 ? null : { text: lines.slice(b, s + 1).join("\n"), start: b };
    }
    if (!marker.test(lines[i])) continue;
    if (/^\s*([-*+]|\d+[.)])\s/.test(lines[i]))
      return { text: lines[i].replace(marker, ""), start: i };
    let start = i;
    while (start > 0 && lines[start - 1].trim() !== "" && !HEADING_RE.test(lines[start - 1]))
      start--;
    const block = lines.slice(start, i + 1);
    block[block.length - 1] = lines[i].replace(marker, "");
    return { text: block.join("\n"), start };
  }
  return null;
}

export const MAX_EMBED_DEPTH = 3;

/**
 * The part of a note a link target shows: the section of `Note#Heading`, the block of `Note#^id`, or
 * the whole body. Null when the heading or block is not in the note.
 */
export function notePart(text: string, target: string): NotePart | null {
  const { heading, block } = parseWikilinkTarget(target);
  if (heading) return headingSectionAt(text, heading);
  if (block) return blockAt(text, block);
  return { text: splitFrontmatter(text).body, start: 0 };
}

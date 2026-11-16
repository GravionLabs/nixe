import { LinkFormat } from "../file/backend";
import { dirname } from "../markdown/paths";
import { SwitcherEntry, fuzzyScore, rank } from "../switcher/fuzzy";

/** Pure parts of the `[[` and `#` autocomplete: where a completion starts, and what it offers. */

export type WikilinkStage =
  | { kind: "note"; from: number; query: string }
  | { kind: "heading"; from: number; note: string; query: string }
  | { kind: "block"; from: number; note: string; query: string };

/**
 * The wikilink being typed at `col` of `line`: after an unclosed `[[`, before any `|` (the alias
 * is free text). `from` is the column where the part to replace starts. `[[Note#` is the heading
 * stage and `[[Note#^` the block stage; `note` is empty for the open note (`[[#`).
 */
export function wikilinkStage(line: string, col: number): WikilinkStage | null {
  const before = line.slice(0, col);
  const open = before.lastIndexOf("[[");
  if (open < 0) return null;
  const typed = before.slice(open + 2);
  if (/[\]|[]/.test(typed)) return null;
  const hash = typed.indexOf("#");
  if (hash < 0) return { kind: "note", from: open + 2, query: typed };
  const note = typed.slice(0, hash).trim();
  const rest = typed.slice(hash + 1);
  if (rest.startsWith("^")) return { kind: "block", from: open + 2 + hash + 2, note, query: rest.slice(1) };
  if (rest.includes("#")) return null;
  return { kind: "heading", from: open + 2 + hash + 1, note, query: rest };
}

const TAG_CHAR = /[\p{L}\p{N}_\-/]/u;

/** The tag being typed at `col`: a `#` at a word start followed by tag characters. */
export function tagStage(line: string, col: number): { from: number; query: string } | null {
  let start = col;
  while (start > 0 && TAG_CHAR.test(line[start - 1]!)) start--;
  if (start === 0 || line[start - 1] !== "#") return null;
  const hash = start - 1;
  if (hash > 0 && !/[\s([{"']/.test(line[hash - 1]!)) return null;
  return { from: start, query: line.slice(start, col) };
}

export interface NoteOption {
  /** What the list shows: the file name or the alias that matched. */
  label: string;
  /** Vault-relative path, the second line of the entry. */
  detail: string;
  /** What goes between `[[` and `]]`. */
  insert: string;
}

const MAX_OPTIONS = 50;

const withoutExtension = (path: string): string => path.replace(/\.md$/iu, "");

/** The link target of `path` in the vault's link format; `from` is the note the link goes into. */
export function linkTarget(path: string, format: LinkFormat["format"], from: string | null, allPaths: readonly string[]): string {
  const target = withoutExtension(path);
  if (format === "absolute") return target;
  if (format === "relative" && from !== null) return relativeTo(dirname(from) === "." ? "" : dirname(from), target);
  // shortest: the file name, with as many folders in front as it takes to be unambiguous
  const others = allPaths.filter((p) => p !== path).map((p) => withoutExtension(p).toLowerCase());
  const segments = target.split("/");
  for (let n = 1; n < segments.length; n++) {
    const candidate = segments.slice(-n).join("/").toLowerCase();
    if (!others.some((o) => o === candidate || o.endsWith("/" + candidate))) return segments.slice(-n).join("/");
  }
  return target;
}

function relativeTo(fromDir: string, target: string): string {
  const base = fromDir ? fromDir.split("/") : [];
  const to = target.split("/");
  let common = 0;
  while (common < base.length && common < to.length - 1 && base[common] === to[common]) common++;
  return [...Array<string>(base.length - common).fill(".."), ...to.slice(common)].join("/");
}

/** Notes matching `query` (fuzzy over file names and aliases); an alias inserts `Note|Alias`. */
export function noteOptions(
  entries: readonly SwitcherEntry[],
  query: string,
  format: LinkFormat["format"],
  current: string | null,
): NoteOption[] {
  const paths = entries.map((e) => e.path);
  return rank(entries, query)
    .slice(0, MAX_OPTIONS)
    .map((m) => {
      const target = linkTarget(m.entry.path, format, current, paths);
      return { label: m.label, detail: m.entry.path, insert: m.isAlias ? `${target}|${m.label}` : target };
    });
}

export interface HeadingRef {
  level: number;
  text: string;
}

export interface BlockRef {
  id: string;
  /** The text of the block's line, without the id. */
  text: string;
}

/** The lines of `text` that are not front matter or inside a fenced code block, with their text. */
function* bodyLines(text: string): Generator<string> {
  const lines = text.split(/\r?\n/);
  let i = 0;
  if (lines[0]?.trim() === "---") {
    const end = lines.findIndex((l, n) => n > 0 && /^(---|\.\.\.)\s*$/.test(l));
    if (end > 0) i = end + 1;
  }
  let fence: string | null = null;
  for (; i < lines.length; i++) {
    const line = lines[i]!;
    const m = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (m) {
      if (fence === null) fence = m[1]![0]!;
      else if (m[1]![0] === fence) fence = null;
      continue;
    }
    if (fence === null) yield line;
  }
}

/** ATX headings of a note, in order. */
export function headingsOf(text: string): HeadingRef[] {
  const out: HeadingRef[] = [];
  for (const line of bodyLines(text)) {
    const m = /^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/.exec(line);
    if (m && m[2]) out.push({ level: m[1]!.length, text: m[2] });
  }
  return out;
}

/** Block ids (`^id` at the end of a line) of a note, in order. */
export function blocksOf(text: string): BlockRef[] {
  const out: BlockRef[] = [];
  for (const line of bodyLines(text)) {
    const m = /(?:^|\s)\^([A-Za-z0-9-]+)\s*$/.exec(line);
    if (m) out.push({ id: m[1]!, text: line.slice(0, m.index).trim() });
  }
  return out;
}

/** A heading as it is written in a link: characters that break a link become spaces. */
export function headingLinkText(text: string): string {
  return text.replace(/[#^|[\]:]/g, " ").replace(/\s+/g, " ").trim();
}

export interface PlainOption {
  label: string;
  detail?: string;
  insert: string;
}

export function headingOptions(headings: readonly HeadingRef[], query: string): PlainOption[] {
  const q = query.trim();
  return headings
    .map((h) => ({ h, score: q ? fuzzyScore(q, h.text) : 0 }))
    .filter((x): x is { h: HeadingRef; score: number } => x.score !== null)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_OPTIONS)
    .map(({ h }) => ({ label: h.text, detail: "#".repeat(h.level), insert: headingLinkText(h.text) }));
}

export function blockOptions(blocks: readonly BlockRef[], query: string): PlainOption[] {
  const q = query.trim();
  return blocks
    .map((b) => ({ b, score: q ? Math.max(fuzzyScore(q, b.id) ?? -Infinity, fuzzyScore(q, b.text) ?? -Infinity) : 0 }))
    .filter((x) => x.score > -Infinity)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_OPTIONS)
    .map(({ b }) => ({ label: b.id, detail: b.text.slice(0, 80), insert: b.id }));
}

/** Tags matching `query`, the most used first (the input order). */
export function tagOptions(tags: readonly { tag: string; count: number }[], query: string): PlainOption[] {
  const q = query.trim();
  return tags
    .filter((t) => !q || fuzzyScore(q, t.tag) !== null)
    .slice(0, MAX_OPTIONS)
    .map((t) => ({ label: t.tag, detail: String(t.count), insert: t.tag }));
}

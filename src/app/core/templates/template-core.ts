import { parse, parseDocument } from "yaml";

/** Format of `{{date}}` and `{{time}}` without a format (Obsidian's defaults). */
export const DEFAULT_DATE_FORMAT = "YYYY-MM-DD";
export const DEFAULT_TIME_FORMAT = "HH:mm";

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const pad = (n: number, width = 2) => String(Math.abs(n)).padStart(width, "0");

function ordinal(n: number): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  return `${n}${({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10] ?? "th"}`;
}

function dayOfYear(d: Date): number {
  return Math.round(
    (Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) - Date.UTC(d.getFullYear(), 0, 0)) /
      86_400_000,
  );
}

/** ISO 8601 week number. */
function isoWeek(d: Date): number {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
  return Math.ceil(((t.getTime() - Date.UTC(t.getUTCFullYear(), 0, 1)) / 86_400_000 + 1) / 7);
}

function offset(d: Date, colon: boolean): string {
  const minutes = -d.getTimezoneOffset();
  const sign = minutes >= 0 ? "+" : "-";
  return `${sign}${pad(Math.floor(Math.abs(minutes) / 60))}${colon ? ":" : ""}${pad(Math.abs(minutes) % 60)}`;
}

const TOKENS: Record<string, (d: Date) => string> = {
  YYYY: (d) => pad(d.getFullYear(), 4),
  YY: (d) => pad(d.getFullYear() % 100),
  Q: (d) => String(Math.floor(d.getMonth() / 3) + 1),
  MMMM: (d) => MONTHS[d.getMonth()],
  MMM: (d) => MONTHS[d.getMonth()].slice(0, 3),
  MM: (d) => pad(d.getMonth() + 1),
  Mo: (d) => ordinal(d.getMonth() + 1),
  M: (d) => String(d.getMonth() + 1),
  DDDD: (d) => pad(dayOfYear(d), 3),
  DDD: (d) => String(dayOfYear(d)),
  DD: (d) => pad(d.getDate()),
  Do: (d) => ordinal(d.getDate()),
  D: (d) => String(d.getDate()),
  dddd: (d) => DAYS[d.getDay()],
  ddd: (d) => DAYS[d.getDay()].slice(0, 3),
  dd: (d) => DAYS[d.getDay()].slice(0, 2),
  d: (d) => String(d.getDay()),
  E: (d) => String(d.getDay() || 7),
  WW: (d) => pad(isoWeek(d)),
  W: (d) => String(isoWeek(d)),
  HH: (d) => pad(d.getHours()),
  H: (d) => String(d.getHours()),
  hh: (d) => pad(d.getHours() % 12 || 12),
  h: (d) => String(d.getHours() % 12 || 12),
  kk: (d) => pad(d.getHours() || 24),
  k: (d) => String(d.getHours() || 24),
  mm: (d) => pad(d.getMinutes()),
  m: (d) => String(d.getMinutes()),
  ss: (d) => pad(d.getSeconds()),
  s: (d) => String(d.getSeconds()),
  SSS: (d) => pad(d.getMilliseconds(), 3),
  SS: (d) => pad(Math.floor(d.getMilliseconds() / 10)),
  S: (d) => String(Math.floor(d.getMilliseconds() / 100)),
  A: (d) => (d.getHours() < 12 ? "AM" : "PM"),
  a: (d) => (d.getHours() < 12 ? "am" : "pm"),
  ZZ: (d) => offset(d, false),
  Z: (d) => offset(d, true),
  X: (d) => String(Math.floor(d.getTime() / 1000)),
  x: (d) => String(d.getTime()),
};

/** Source of the pattern that finds a `[literal]` (group 1) or a Moment token in a format. */
export const FORMAT_SOURCE =
  "\\[([^\\]]*)\\]|" +
  Object.keys(TOKENS)
    .sort((a, b) => b.length - a.length)
    .join("|");
const FORMAT_RE = new RegExp(FORMAT_SOURCE, "g");

/** Formats a date with Moment.js tokens (English); text in `[brackets]` stays as it is. */
export function formatMoment(date: Date, format: string): string {
  return format.replace(FORMAT_RE, (match: string, literal: string | undefined) =>
    literal !== undefined ? literal : TOKENS[match](date),
  );
}

export interface TemplateContext {
  /** Name of the note without extension. */
  title: string;
  now: Date;
}

/**
 * Replaces `{{title}}`, `{{date}}`, `{{time}}`, `{{date:FORMAT}}` and `{{time:FORMAT}}`.
 * Other `{{…}}` text stays as it is.
 */
export function expandTemplate(text: string, ctx: TemplateContext): string {
  return text.replace(
    /\{\{\s*(title|date|time)\s*(?::([^}]*))?\}\}/g,
    (_m, name: string, format: string | undefined) => {
      if (name === "title") return ctx.title;
      const fallback = name === "date" ? DEFAULT_DATE_FORMAT : DEFAULT_TIME_FORMAT;
      return formatMoment(ctx.now, format?.trim() ? format.trim() : fallback);
    },
  );
}

interface Split {
  /** The YAML between the fences; null when the text has no frontmatter block. */
  yaml: string | null;
  /** Offset of the first character after the closing fence line (0 without frontmatter). */
  bodyStart: number;
}

function splitAt(text: string): Split {
  const fence = /^---[ \t]*\r?\n/.exec(text);
  if (!fence) return { yaml: null, bodyStart: 0 };
  const close = /^(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/m;
  const rest = text.slice(fence[0].length);
  const m = close.exec(rest);
  if (!m) return { yaml: null, bodyStart: 0 };
  return {
    yaml: rest.slice(0, m.index).replace(/\r?\n$/, ""),
    bodyStart: fence[0].length + m.index + m[0].length,
  };
}

export interface TextChange {
  from: number;
  to: number;
  insert: string;
}

export interface TemplateInsertion {
  /** Changes in the coordinates of the note text; they do not overlap. */
  changes: TextChange[];
  /** Cursor position in the text after the changes. */
  cursor: number;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBlank(value: unknown): boolean {
  return (
    value === null ||
    value === undefined ||
    value === "" ||
    (Array.isArray(value) && value.length === 0)
  );
}

/**
 * Adds the properties of `add` to the frontmatter `yaml` (null: none). A property the note already
 * has keeps its value, except an empty one, which takes the template's; lists are joined without
 * duplicates. Comments and the order of the note's properties stay.
 */
function mergeFrontmatter(yaml: string | null, add: Record<string, unknown>): string {
  const doc = parseDocument(yaml ?? "");
  for (const [key, value] of Object.entries(add)) {
    if (!doc.has(key)) {
      doc.set(key, value);
      continue;
    }
    const existing = doc.toJS()[key] as unknown;
    if (Array.isArray(existing) && Array.isArray(value)) {
      const seen = new Set(existing.map((v) => JSON.stringify(v)));
      const extra = value.filter((v) => !seen.has(JSON.stringify(v)));
      if (extra.length) doc.set(key, [...existing, ...extra]);
    } else if (isBlank(existing) && !isBlank(value)) {
      doc.set(key, value);
    }
  }
  return `---\n${doc.toString().trimEnd()}\n---\n`;
}

/**
 * Inserts an expanded template into a note. The body goes to the cursor (below the frontmatter when
 * the cursor is inside it); the template's frontmatter is merged into the note's instead of being
 * inserted. Throws when the frontmatter of the note is not valid YAML.
 */
export function insertTemplate(
  noteText: string,
  cursor: number,
  template: string,
): TemplateInsertion {
  const tpl = splitAt(template);
  let data: Record<string, unknown> = {};
  let merge = false;
  if (tpl.yaml !== null) {
    try {
      const value: unknown = parse(tpl.yaml);
      if (isPlainObject(value)) {
        data = value;
        merge = Object.keys(value).length > 0;
      } else if (value === null || value === undefined) {
        merge = false;
      } else {
        return plainInsertion(noteText, cursor, template);
      }
    } catch {
      return plainInsertion(noteText, cursor, template);
    }
  }
  const body = tpl.yaml !== null ? template.slice(tpl.bodyStart) : template;
  if (!merge) return plainInsertion(noteText, cursor, body);

  const note = splitAt(noteText);
  if (note.yaml !== null) {
    let valid = true;
    try {
      const value: unknown = parse(note.yaml);
      valid = value === null || value === undefined || isPlainObject(value);
    } catch {
      valid = false;
    }
    if (!valid)
      throw new Error(
        "The frontmatter of this note is not valid YAML; fix it before inserting a template.",
      );
  }
  const merged = mergeFrontmatter(note.yaml, data);
  const pos = Math.max(cursor, note.bodyStart);
  const changes: TextChange[] = [{ from: 0, to: note.bodyStart, insert: merged }];
  if (body) changes.push({ from: pos, to: pos, insert: body });
  return { changes, cursor: pos - note.bodyStart + merged.length + body.length };
}

function plainInsertion(noteText: string, cursor: number, body: string): TemplateInsertion {
  const pos = Math.max(cursor, splitAt(noteText).bodyStart);
  return { changes: body ? [{ from: pos, to: pos, insert: body }] : [], cursor: pos + body.length };
}

/** Applies the changes of an insertion to a text (the editor does the same with its own state). */
export function applyChanges(text: string, changes: readonly TextChange[]): string {
  let out = "";
  let at = 0;
  for (const c of changes) {
    out += text.slice(at, c.from) + c.insert;
    at = c.to;
  }
  return out + text.slice(at);
}

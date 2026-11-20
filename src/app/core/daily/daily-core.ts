import { DEFAULT_DATE_FORMAT, FORMAT_SOURCE, formatMoment } from "../templates/template-core";

export interface DailyConfig {
  /** Vault-relative folder without slashes at the ends; empty is the vault root. */
  folder: string;
  /** Moment format of the note name; may contain `/` for nested folders (`YYYY/MM/YYYY-MM-DD`). */
  format: string;
  /** Vault-relative path of the template note without `.md`; empty for none. */
  template: string;
}

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

export function trimSlashes(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
}

/** Vault-relative path of the daily note of `date`, with `.md`. */
export function dailyPath(date: Date, config: Pick<DailyConfig, "folder" | "format">): string {
  const name = trimSlashes(formatMoment(date, config.format.trim() || DEFAULT_DATE_FORMAT));
  const folder = trimSlashes(config.folder);
  const path = folder ? `${folder}/${name}` : name;
  if (!name || path.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new Error(`${path || config.format}: not a path in the vault.`);
  }
  return `${path}.md`;
}

const escapeRe = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

interface Matcher {
  re: RegExp;
  /** Capture group of year, month and day: `kind` tells how to read it. */
  groups: { kind: "YYYY" | "YY" | "month" | "monthName" | "day"; index: number }[];
}

/** A pattern for the note names of a format: year, month and day are read, other tokens match anything. */
function matcherFor(format: string): Matcher | null {
  const token = new RegExp(FORMAT_SOURCE, "g");
  const groups: Matcher["groups"] = [];
  let source = "";
  let at = 0;
  const capture = (kind: Matcher["groups"][number]["kind"], pattern: string) => {
    groups.push({ kind, index: groups.length + 1 });
    return `(${pattern})`;
  };
  for (let m = token.exec(format); m; m = token.exec(format)) {
    source += escapeRe(format.slice(at, m.index));
    at = m.index + m[0].length;
    const t = m[0];
    if (m[1] !== undefined) source += escapeRe(m[1]);
    else if (t === "YYYY") source += capture("YYYY", "\\d{4}");
    else if (t === "YY") source += capture("YY", "\\d{2}");
    else if (t === "MM") source += capture("month", "\\d{2}");
    else if (t === "M") source += capture("month", "\\d{1,2}");
    else if (t === "MMMM") source += capture("monthName", MONTHS.join("|"));
    else if (t === "MMM")
      source += capture("monthName", MONTHS.map((n) => n.slice(0, 3)).join("|"));
    else if (t === "DD") source += capture("day", "\\d{2}");
    else if (t === "D") source += capture("day", "\\d{1,2}");
    else if (t === "Do") source += `${capture("day", "\\d{1,2}")}(?:st|nd|rd|th)`;
    else source += "[^/]+?";
  }
  source += escapeRe(format.slice(at));
  const kinds = new Set(groups.map((g) => g.kind));
  const hasYear = kinds.has("YYYY") || kinds.has("YY");
  const hasMonth = kinds.has("month") || kinds.has("monthName");
  if (!hasYear || !hasMonth || !kinds.has("day")) return null;
  return { re: new RegExp(`^${source}$`), groups };
}

/**
 * The date a daily note path stands for (`folder/format.md`), or null when the path is no daily
 * note, or the format has no year, month and day to read.
 */
export function parseDailyPath(
  path: string,
  config: Pick<DailyConfig, "folder" | "format">,
): Date | null {
  const matcher = matcherFor(config.format.trim() || DEFAULT_DATE_FORMAT);
  if (!matcher || !path.toLowerCase().endsWith(".md")) return null;
  const folder = trimSlashes(config.folder);
  let rest = path.slice(0, -3);
  if (folder) {
    if (!rest.startsWith(`${folder}/`)) return null;
    rest = rest.slice(folder.length + 1);
  }
  const m = matcher.re.exec(rest);
  if (!m) return null;
  let year = 0;
  let month = 0;
  let day = 0;
  for (const { kind, index } of matcher.groups) {
    const v = m[index];
    if (kind === "YYYY") year = Number(v);
    else if (kind === "YY") year = 2000 + Number(v);
    else if (kind === "month") month = Number(v);
    else if (kind === "monthName") month = MONTHS.findIndex((n) => n.startsWith(v)) + 1;
    else day = Number(v);
  }
  const date = new Date(year, month - 1, day);
  const valid =
    month >= 1 &&
    month <= 12 &&
    date.getFullYear() === year &&
    date.getMonth() === month - 1 &&
    date.getDate() === day;
  return valid ? date : null;
}

/**
 * The existing daily note nearest before (`-1`) or after (`1`) `from` among `files` (vault-relative
 * paths); null when there is none.
 */
export function neighborDaily(
  files: readonly string[],
  from: Date,
  direction: -1 | 1,
  config: Pick<DailyConfig, "folder" | "format">,
): string | null {
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const origin = day(from);
  let best: { path: string; time: number } | null = null;
  for (const path of files) {
    const date = parseDailyPath(path, config);
    if (!date) continue;
    const time = day(date);
    if (direction === -1 ? time >= origin : time <= origin) continue;
    if (!best || (direction === -1 ? time > best.time : time < best.time)) best = { path, time };
  }
  return best?.path ?? null;
}

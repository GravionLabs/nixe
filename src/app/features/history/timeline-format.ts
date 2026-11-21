import type { TimelineEntry } from "../../core/git/history.service";

const DAY = 86_400_000;
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Midnight (local time) of the day of `ms`. */
function startOfDay(ms: number): number {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** Days between the calendar day of `ms` and the one of `now` (DST safe). */
function daysAgo(ms: number, now: number): number {
  return Math.round((startOfDay(now) - startOfDay(ms)) / DAY);
}

/** "Today", "Yesterday", the weekday within the last week, then the date (`21 Nov 2026`). */
export function dayLabel(secs: number, now: number): string {
  const ms = secs * 1000;
  const days = daysAgo(ms, now);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  const d = new Date(ms);
  if (days < 7) return WEEKDAYS[d.getDay()];
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

function plural(n: number, unit: string): string {
  return `${n} ${unit}${n === 1 ? "" : "s"} ago`;
}

/** "just now", "5 minutes ago", "2 hours ago", "3 days ago", ... */
export function relativeTime(secs: number, now: number): string {
  const diff = Math.max(0, Math.floor(now / 1000) - secs);
  if (diff < 60) return "just now";
  if (diff < 3600) return plural(Math.floor(diff / 60), "minute");
  if (diff < 86_400) return plural(Math.floor(diff / 3600), "hour");
  if (diff < 30 * 86_400) return plural(Math.floor(diff / 86_400), "day");
  if (diff < 365 * 86_400) return plural(Math.floor(diff / (30 * 86_400)), "month");
  return plural(Math.floor(diff / (365 * 86_400)), "year");
}

/** The exact local time, for the tooltip: `2026-11-21 14:05`. */
export function exactTime(secs: number): string {
  const d = new Date(secs * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

const OPERATIONS: Record<string, { icon: string; verb: string }> = {
  rename: { icon: "✎", verb: "Renamed" },
  move: { icon: "➜", verb: "Moved" },
  merge: { icon: "⇉", verb: "Merged" },
  extract: { icon: "⇱", verb: "Extracted a section" },
  delete: { icon: "🗑", verb: "Deleted" },
  discard: { icon: "↶", verb: "Discarded changes" },
  restore: { icon: "⟲", verb: "Restored" },
};

/** What a row shows: an icon for an operation, and the sentence. */
export interface EntryText {
  icon: string | null;
  text: string;
}

/** `rename: a.md -> b.md, links in 2 notes` → `a.md → b.md`. */
function targets(message: string): string {
  const rest = message
    .slice(message.indexOf(":") + 1)
    .split(",")[0]
    .trim();
  return rest.replace(/\s*->\s*/, " → ");
}

/** The plain sentence of an entry: automatic backup, operation, or the message itself. */
export function describeEntry(entry: TimelineEntry): EntryText {
  if (entry.id === null) return { icon: null, text: entry.message };
  if (entry.operation) {
    const op = OPERATIONS[entry.operation];
    if (op) {
      const detail = entry.message.includes(":") ? targets(entry.message) : "";
      return { icon: op.icon, text: detail ? `${op.verb}: ${detail}` : op.verb };
    }
    return { icon: "•", text: entry.message };
  }
  if (/^vault backup:/i.test(entry.message) || /^checkpoint before /i.test(entry.message)) {
    return { icon: null, text: "Automatic save" };
  }
  return { icon: null, text: entry.message };
}

/** A day of the timeline with its entries. */
export interface DayGroup {
  label: string;
  entries: TimelineEntry[];
}

/** Groups the newest-first timeline by day; the uncommitted state comes first, ungrouped by day ("Now"). */
export function groupByDay(entries: readonly TimelineEntry[], now: number): DayGroup[] {
  const groups: DayGroup[] = [];
  for (const entry of entries) {
    const label = entry.id === null ? "Now" : dayLabel(entry.time, now);
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.entries.push(entry);
    else groups.push({ label, entries: [entry] });
  }
  return groups;
}

/** True when the committed entries have more than one author. */
export function hasSeveralAuthors(entries: readonly TimelineEntry[]): boolean {
  return new Set(entries.filter((e) => e.id !== null && e.author).map((e) => e.author)).size > 1;
}

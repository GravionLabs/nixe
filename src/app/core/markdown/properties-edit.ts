import type { PropertyType } from "./properties";

/** Types a new property can start with (`link` is text that happens to hold a wikilink). */
export const NEW_PROPERTY_TYPES: readonly { type: PropertyType; label: string }[] = [
  { type: "text", label: "Text" },
  { type: "number", label: "Number" },
  { type: "checkbox", label: "Checkbox" },
  { type: "date", label: "Date" },
  { type: "list", label: "List" },
  { type: "tags", label: "Tags" },
];

const SUMMARY_PROPS = 2;
const SUMMARY_VALUE = 24;

function summaryValue(value: unknown): string {
  const text = Array.isArray(value)
    ? value.map((v) => String(v)).join(", ")
    : typeof value === "object" && value !== null
      ? JSON.stringify(value)
      : typeof value === "string" || typeof value === "number" || typeof value === "boolean"
        ? String(value)
        : "";
  return text.length > SUMMARY_VALUE ? `${text.slice(0, SUMMARY_VALUE - 1)}…` : text;
}

/** The one line of a folded panel: `Properties · 6 · tags: rust, idea · status: draft`. */
export function propertiesSummary(props: readonly { key: string; value: unknown }[]): string {
  const first = props.slice(0, SUMMARY_PROPS).map((p) => `${p.key}: ${summaryValue(p.value)}`);
  return ["Properties", String(props.length), ...first].join(" · ");
}

/** The first value of a new property; `today` is `YYYY-MM-DD`. */
export function initialValue(type: PropertyType, today: string): unknown {
  switch (type) {
    case "number":
      return 0;
    case "checkbox":
      return false;
    case "date":
      return today;
    case "list":
    case "tags":
      return [];
    default:
      return "";
  }
}

/** The items of a list-like value as text, empty ones dropped. */
export function listItems(value: unknown): string[] {
  const items = Array.isArray(value)
    ? value
    : value === null || value === undefined || value === ""
      ? []
      : [value];
  return items.map((v) => String(v ?? "").trim()).filter(Boolean);
}

/** The stored items of a list-like value, unchanged: a chip edit writes them back as they are. */
export function storedItems(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  return value === null || value === undefined || value === "" ? [] : [value];
}

/** One chip: its text and the place of its item among the stored items. */
export interface Chip {
  text: string;
  index: number;
}

/** A mapping or a list as JSON, anything else as its trimmed text. */
const chipTextOf = (item: unknown): string =>
  typeof item === "object" && item !== null
    ? JSON.stringify(item)
    : String((item as string | number | boolean | null | undefined) ?? "").trim();

/** The chips of a list-like value; an empty item has none but keeps its place. */
export function chipsOf(value: unknown): Chip[] {
  return storedItems(value)
    .map((item, index) => ({
      text: chipTextOf(item),
      index,
    }))
    .filter((chip) => chip.text);
}

/** A list with a mapping or a list in it cannot be changed chip by chip without losing parts. */
export function chipsEditable(value: unknown): boolean {
  return storedItems(value).every((item) => item === null || typeof item !== "object");
}

/** A tag is stored without its `#`; other chips are kept as typed. */
export function chipText(key: string, raw: string): string {
  const text = raw.trim();
  return /^tags?$/i.test(key) ? text.replace(/^#+/, "") : text;
}

/** Index values that match `query` (case-insensitive, prefix matches first) and are not yet in the list. */
export function chipSuggestions(
  all: readonly string[],
  query: string,
  taken: readonly string[],
  max = 8,
): string[] {
  const q = query.trim().replace(/^#/, "").toLowerCase();
  const used = new Set(taken.map((t) => t.toLowerCase()));
  const hits = all.filter((v) => !used.has(v.toLowerCase()) && (!q || v.toLowerCase().includes(q)));
  hits.sort(
    (a, b) => Number(!a.toLowerCase().startsWith(q)) - Number(!b.toLowerCase().startsWith(q)),
  );
  return hits.slice(0, max);
}

/** The number typed into a number control; null for an empty or invalid entry. */
export function parseNumber(raw: string): number | null {
  if (raw.trim() === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** Date-only values get the native date control, anything with a time stays text. */
export const isDateOnly = (value: unknown): boolean =>
  typeof value === "string" && DATE_ONLY.test(value);

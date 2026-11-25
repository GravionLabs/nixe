import type { BaseCell } from "../../core/file/backend";
import type { PropertyChange } from "../../core/markdown/property-change";
import { detectType, type PropertyType } from "../../core/markdown/properties";
import { chipText, isDateOnly, listItems, parseNumber } from "../../core/markdown/properties-edit";

/** The input a cell is edited with. */
export type CellEditor = "text" | "number" | "checkbox" | "date" | "list" | "tags";

const TAG_KEYS = /^(tags?|alias(es)?)$/i;

/** The items of a list value; tags written as one text are split like the index reads them. */
export function cellItems(property: string, value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value === "string" && /^tags?$/i.test(property))
    return value.split(/[,\s]+/).filter(Boolean);
  return listItems(value);
}

const isScalar = (value: unknown): boolean => value === null || typeof value !== "object";

/** A mapping and a list that holds one cannot be edited in a cell without losing parts. */
function editable(value: unknown): boolean {
  return Array.isArray(value) ? value.every(isScalar) : isScalar(value);
}

/** A date control empties a day that does not exist (`2024-02-30`): that stays a text. */
function isCalendarDate(value: unknown): boolean {
  if (!isDateOnly(value)) return false;
  const time = Date.parse(`${value as string}T00:00:00Z`);
  return !Number.isNaN(time) && new Date(time).toISOString().startsWith(value as string);
}

function editorOf(property: string, value: unknown): CellEditor {
  const type: PropertyType = detectType(property, value);
  if (type === "link") return "text";
  // A date with a time has no native control that keeps it as it is written.
  if (type === "date") return isCalendarDate(value) ? "date" : "text";
  return type;
}

/**
 * The input for the cell of the note property `property`; null when it cannot be edited. An empty
 * cell takes the type of the first value in its `column`.
 */
export function cellEditor(
  property: string,
  cell: BaseCell,
  column: readonly BaseCell[],
): CellEditor | null {
  if (cell.type === "error" || !editable(cell.value)) return null;
  if (TAG_KEYS.test(property)) return "tags";
  if (cell.value !== null && cell.value !== undefined) return editorOf(property, cell.value);
  const other = column.find((c) => c.value !== null && c.value !== undefined);
  return other && editable(other.value) ? editorOf(property, other.value) : "text";
}

/** The cell that shows the property value `value`, typed like the index does. */
export function cellOfValue(value: unknown): BaseCell {
  if (value === null || value === undefined) return { type: null, value: null };
  if (typeof value === "boolean") return { type: "checkbox", value };
  if (typeof value === "number") return { type: "number", value };
  if (Array.isArray(value)) return { type: "list", value };
  return { type: detectType("", value) === "date" ? "date" : "text", value };
}

/** The change for the text typed into a cell; null for an entry that is no value of its type. */
export function typedChange(editor: CellEditor, raw: string): PropertyChange | null {
  if (editor !== "number") return () => raw;
  const number = parseNumber(raw);
  return number === null ? null : () => number;
}

/** Adds an item to a list, made from the items the note holds when the change is applied. */
export function addItem(property: string, raw: string): PropertyChange | null {
  const text = chipText(property, raw);
  if (!text) return null;
  return (current) => {
    const items = cellItems(property, current);
    const known = items.some((i) => String(i).toLowerCase() === text.toLowerCase());
    return known ? current : [...items, text];
  };
}

/** Removes the first item that equals `item` from a list. */
export function removeItem(property: string, item: unknown): PropertyChange {
  return (current) => {
    const items = cellItems(property, current);
    const at = items.findIndex((i) => i === item);
    return at < 0 ? current : items.filter((_, i) => i !== at);
  };
}

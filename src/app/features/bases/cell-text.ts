import type { BaseCell, BaseLink } from "../../core/file/backend";

/** A value of a base table as text; empty for a missing or empty property. */
export function cellText(cell: BaseCell): string {
  if (cell.type === "link") return (cell.value as BaseLink).text;
  return valueText(cell.value);
}

function valueText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return value.map(valueText).join(", ");
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

export type PropertyType = "text" | "number" | "checkbox" | "date" | "list" | "link" | "tags";

export interface Property {
  key: string;
  type: PropertyType;
  value: unknown;
}

const DATE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;
const WIKILINK = /\[\[([^\]|#\n]*)(?:#([^\]|\n]*))?(?:\|([^\]\n]*))?\]\]/g;

/** Chip lists: `tags` and `aliases` (Obsidian also accepts the singular keys). */
const CHIP_KEYS = new Set(["tags", "tag", "aliases", "alias"]);

export function detectType(key: string, value: unknown): PropertyType {
  if (CHIP_KEYS.has(key.toLowerCase())) return "tags";
  if (typeof value === "boolean") return "checkbox";
  if (typeof value === "number") return "number";
  if (Array.isArray(value)) return "list";
  if (value instanceof Date) return "date";
  if (typeof value === "string") {
    if (DATE.test(value.trim())) return "date";
    if (/\[\[[^\]]+\]\]/.test(value)) return "link";
  }
  return "text";
}

export function toProperties(data: Record<string, unknown>): Property[] {
  return Object.entries(data).map(([key, value]) => ({ key, type: detectType(key, value), value }));
}

/** Normalizes a frontmatter tag: strips a leading `#`, accepts a list or a comma/space separated string. */
export function frontmatterTags(data: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const [key, value] of Object.entries(data)) {
    if (key.toLowerCase() !== "tags" && key.toLowerCase() !== "tag") continue;
    const items = Array.isArray(value)
      ? value
      : typeof value === "string"
        ? value.split(/[,\s]+/)
        : [];
    for (const item of items) {
      const tag = String(item ?? "")
        .trim()
        .replace(/^#/, "");
      if (tag) out.push(tag);
    }
  }
  return out;
}

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function scalarText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint")
    return String(value);
  return JSON.stringify(value);
}

/** Text with `[[target|alias]]` converted to wikilink anchors; everything else escaped. */
export function renderLinks(text: string): string {
  let out = "";
  let last = 0;
  for (const m of text.matchAll(WIKILINK)) {
    out += esc(text.slice(last, m.index));
    const target = m[1].trim();
    const anchor = m[2]?.trim();
    const label = (m[3] ?? m[1] + (anchor ? `#${anchor}` : "")).trim();
    const href = encodeURI(target) + (anchor ? `#${encodeURI(anchor)}` : "");
    out += `<a class="wikilink" href="${esc(href)}" data-wikilink="${esc(target)}">${esc(label)}</a>`;
    last = (m.index ?? 0) + m[0].length;
  }
  return out + esc(text.slice(last));
}

function renderValue(p: Property): string {
  switch (p.type) {
    case "checkbox":
      return `<input type="checkbox" disabled${p.value ? " checked" : ""}>`;
    case "tags": {
      const items = Array.isArray(p.value) ? p.value : [p.value];
      const chips = items
        .map((v) => scalarText(v).trim().replace(/^#/, ""))
        .filter(Boolean)
        .map((v) =>
          p.key.toLowerCase().startsWith("tag")
            ? `<a class="tag" href="#" data-tag="${esc(v)}">#${esc(v)}</a>`
            : `<span class="property-chip">${esc(v)}</span>`,
        );
      return `<span class="property-chips">${chips.join("")}</span>`;
    }
    case "list": {
      const items = (p.value as unknown[]).map(
        (v) => `<li class="property-list-item">${renderLinks(scalarText(v))}</li>`,
      );
      return `<ul class="property-list">${items.join("")}</ul>`;
    }
    case "link":
      return renderLinks(scalarText(p.value));
    default:
      return esc(scalarText(p.value));
  }
}

/** HTML of the properties panel (unsanitized, like the rest of the renderer output). */
export function renderPropertiesHtml(props: Property[], error: string | null): string {
  let html = "";
  if (error) {
    html += `<div class="frontmatter-warning" role="alert">Invalid frontmatter: ${esc(error)}</div>\n`;
  }
  if (props.length) {
    const rows = props
      .map(
        (p) =>
          `<div class="property" data-type="${p.type}"><dt class="property-key">${esc(p.key)}</dt><dd class="property-value">${renderValue(p)}</dd></div>`,
      )
      .join("");
    html += `<dl class="properties">${rows}</dl>\n`;
  }
  return html;
}

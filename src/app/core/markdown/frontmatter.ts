import { parse } from "yaml";

export interface FrontmatterResult {
  /** Parsed YAML as a plain object; empty when there is no (valid) frontmatter. */
  data: Record<string, unknown>;
  /** The note without its frontmatter; the removed lines are blanked so line numbers stay stable. */
  body: string;
  /** True when the note starts with a frontmatter block. */
  present: boolean;
  /** Parse error message when the YAML is invalid (or not a mapping). */
  error: string | null;
}

const FENCE = /^---[ \t]*$/;

/** Splits YAML frontmatter (`---` fences at the very top) from the Markdown body. */
export function splitFrontmatter(text: string): FrontmatterResult {
  const none: FrontmatterResult = { data: {}, body: text, present: false, error: null };
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const lines = source.split("\n");
  if (!FENCE.test(lines[0]?.replace(/\r$/, "") ?? "")) return none;

  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].replace(/\r$/, "");
    if (FENCE.test(line) || line === "...") {
      close = i;
      break;
    }
  }
  if (close < 0) return none;

  const yamlText = lines
    .slice(1, close)
    .map((l) => l.replace(/\r$/, ""))
    .join("\n");
  const body = "\n".repeat(close + 1) + lines.slice(close + 1).join("\n");

  let data: Record<string, unknown> = {};
  let error: string | null = null;
  try {
    const value: unknown = parse(yamlText);
    if (value === null || value === undefined) {
      data = {};
    } else if (typeof value === "object" && !Array.isArray(value)) {
      data = value as Record<string, unknown>;
    } else {
      error = "Frontmatter must be a YAML mapping (key: value).";
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }
  return { data, body, present: true, error };
}

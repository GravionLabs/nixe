/** A `[[` the caret is inside of, with the text typed after it. */
export interface WikilinkQuery {
  /** Index of the first `[` of the `[[`. */
  start: number;
  query: string;
}

/** The unfinished `[[…` before the caret, or null when the caret is not inside one. */
export function wikilinkQueryAt(text: string, caret: number): WikilinkQuery | null {
  const before = text.slice(0, caret);
  const start = before.lastIndexOf("[[");
  if (start < 0) return null;
  const query = before.slice(start + 2);
  if (/[\]\n|#^]/.test(query)) return null;
  return { start, query };
}

/** Names that contain every word of the query, the ones that start with it first. At most `limit`. */
export function completeNames(names: readonly string[], query: string, limit = 8): string[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const hits = names.filter((n) => {
    const lower = n.toLowerCase();
    return words.every((w) => lower.includes(w));
  });
  const q = query.trim().toLowerCase();
  const starts = hits.filter((n) => n.toLowerCase().startsWith(q));
  return [...starts, ...hits.filter((n) => !starts.includes(n))].slice(0, limit);
}

/** The text with the open `[[…` replaced by `[[name]]`, and the caret behind it. */
export function applyCompletion(
  text: string,
  caret: number,
  link: WikilinkQuery,
  name: string,
): { text: string; caret: number } {
  const after = text.slice(caret);
  // A `]]` the editor already typed after the caret is not doubled.
  const rest = after.startsWith("]]") ? after.slice(2) : after;
  const insert = `[[${name}]]`;
  return { text: text.slice(0, link.start) + insert + rest, caret: link.start + insert.length };
}

/** True for text that is one `http(s)` URL and nothing else. */
export function isUrl(text: string): boolean {
  const t = text.trim();
  return /^https?:\/\/\S+$/i.test(t) && t.length > "https://".length;
}

/** `[title](url)`; the characters that would end the link text are escaped. */
export function markdownLink(url: string, title: string | null): string {
  const target = url.trim();
  const label = (title ?? "").replace(/\s+/g, " ").trim();
  if (!label) return target;
  const escaped = label.replace(/([\\[\]])/g, "\\$1");
  return `[${escaped}](${target.replace(/\)/g, "%29").replace(/ /g, "%20")})`;
}

/** The text with `insert` at the selection, and the caret behind it. */
export function insertAt(
  text: string,
  start: number,
  end: number,
  insert: string,
): { text: string; caret: number } {
  return { text: text.slice(0, start) + insert + text.slice(end), caret: start + insert.length };
}

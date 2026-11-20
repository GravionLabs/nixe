/** Matcher of the reading-view find bar. No framework or DOM imports: it works on plain text. */

export interface FindOptions {
  caseSensitive: boolean;
  regex: boolean;
}

export interface FindMatch {
  from: number;
  to: number;
}

/** A piece of rendered text; `group` identifies its block, so a match never crosses two blocks. */
export interface TextPart {
  text: string;
  group: number;
}

/** The slice of one part a match covers. */
export interface Segment {
  part: number;
  from: number;
  to: number;
  /** Index of the match this slice belongs to. */
  match: number;
}

const MAX_MATCHES = 5000;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/** The regular expression of a query, or an error message when the query is no valid regex. */
export function buildPattern(query: string, options: FindOptions): RegExp | string | null {
  if (!query) return null;
  try {
    return new RegExp(
      options.regex ? query : escapeRegExp(query),
      options.caseSensitive ? "g" : "gi",
    );
  } catch (error) {
    return error instanceof Error ? error.message : "Invalid regular expression";
  }
}

/** All non-empty matches of `query` in `text`, in order (at most 5000). */
export function findMatches(
  text: string,
  query: string,
  options: FindOptions,
): FindMatch[] | string {
  const pattern = buildPattern(query, options);
  if (pattern === null) return [];
  if (typeof pattern === "string") return pattern;
  const matches: FindMatch[] = [];
  for (const m of text.matchAll(pattern)) {
    if (m[0].length === 0) continue;
    matches.push({ from: m.index, to: m.index + m[0].length });
    if (matches.length >= MAX_MATCHES) break;
  }
  return matches;
}

/** Joins the parts (a newline between two groups) and finds the matches, mapped back onto the parts. */
export function findInParts(
  parts: readonly TextPart[],
  query: string,
  options: FindOptions,
): { matches: FindMatch[]; segments: Segment[] } | string {
  let text = "";
  const starts: number[] = [];
  parts.forEach((part, i) => {
    if (i > 0 && parts[i - 1]!.group !== part.group) text += "\n";
    starts.push(text.length);
    text += part.text;
  });
  const matches = findMatches(text, query, options);
  if (typeof matches === "string") return matches;
  const segments: Segment[] = [];
  matches.forEach((match, index) => {
    parts.forEach((part, i) => {
      const from = Math.max(match.from, starts[i]!) - starts[i]!;
      const to = Math.min(match.to, starts[i]! + part.text.length) - starts[i]!;
      if (to > from) segments.push({ part: i, from, to, match: index });
    });
  });
  return { matches, segments };
}

/** The index after `current` going `step` (1 or -1) through `count` matches, wrapping around. */
export function stepIndex(current: number, step: 1 | -1, count: number): number {
  if (count <= 0) return -1;
  if (current < 0) return step === 1 ? 0 : count - 1;
  return (current + step + count) % count;
}

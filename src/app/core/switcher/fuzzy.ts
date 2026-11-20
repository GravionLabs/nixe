export interface SwitcherEntry {
  /** Vault-relative path. */
  path: string;
  title: string;
  aliases: readonly string[];
  /** Name of the workspace root the note is in; set only while a workspace is open (#117). */
  root?: string;
  /** Absolute path of that root; `path` is relative to it. */
  rootPath?: string;
}

export interface SwitcherMatch {
  entry: SwitcherEntry;
  /** The text that matched: the file name or one of the aliases. */
  label: string;
  isAlias: boolean;
  score: number;
  /** Indices in `label` of the matched characters; empty without a query. */
  positions: readonly number[];
}

export interface FuzzyMatch {
  score: number;
  /** Indices in the text of the matched characters, ascending. */
  positions: number[];
}

/** A run of text of a label, matched or not. */
export interface LabelPart {
  text: string;
  matched: boolean;
}

/** Splits `label` into runs of matched and unmatched characters at `positions`. */
export function highlightParts(label: string, positions: readonly number[]): LabelPart[] {
  const hit = new Set(positions);
  const parts: LabelPart[] = [];
  for (const [i, ch] of [...label].entries()) {
    const matched = hit.has(i);
    const last = parts[parts.length - 1];
    if (last && last.matched === matched) last.text += ch;
    else parts.push({ text: ch, matched });
  }
  return parts;
}

const SEPARATORS = /[\s\-_./\\]/u;

/**
 * Fuzzy score of `query` against `text`: every query character must occur in order
 * (case-insensitive). Higher is better; null means no match. Rewards a prefix, matches at
 * word starts and consecutive runs, and penalises gaps and long texts.
 */
export function fuzzyScore(query: string, text: string): number | null {
  return fuzzyMatch(query, text)?.score ?? null;
}

/** Like `fuzzyScore`, and also returns the positions of the matched characters. */
export function fuzzyMatch(query: string, text: string): FuzzyMatch | null {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (!q) return { score: 0, positions: [] };
  if (q.length > t.length) return null;

  const positions: number[] = [];
  let score = 0;
  let from = 0;
  let previous = -2;
  for (const [index, ch] of [...q].entries()) {
    // Prefer a word start over the first occurrence when both are possible.
    let at = t.indexOf(ch, from);
    if (at < 0) return null;
    if (at !== previous + 1 && !isWordStart(t, at)) {
      for (let next = t.indexOf(ch, at + 1); next >= 0; next = t.indexOf(ch, next + 1)) {
        // Only jump when the rest of the query still fits behind the word start.
        if (isWordStart(t, next) && isSubsequence(q.slice(index + 1), t, next + 1)) {
          at = next;
          break;
        }
      }
    }
    if (at === previous + 1) score += 8;
    else score -= Math.min(at - previous - 1, 5);
    if (isWordStart(t, at)) score += 6;
    if (at === 0) score += 4;
    positions.push(at);
    previous = at;
    from = at + 1;
  }
  if (t === q) score += 100;
  else if (t.startsWith(q)) score += 20;
  return { score: score - t.length * 0.1, positions };
}

function isSubsequence(query: string, text: string, from: number): boolean {
  for (const ch of query) {
    from = text.indexOf(ch, from) + 1;
    if (from === 0) return false;
  }
  return true;
}

function isWordStart(text: string, at: number): boolean {
  return at === 0 || SEPARATORS.test(text[at - 1]!);
}

/** File name without directory and `.md` extension. */
export function fileLabel(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return name.replace(/\.md$/iu, "");
}

/**
 * Ranks entries by their best fuzzy match over file name and aliases. Ties go to the more
 * recently opened note (`recent` lists vault-relative paths, newest first). Without a query
 * the recent notes come first, then the rest alphabetically.
 */
export function rank(
  entries: readonly SwitcherEntry[],
  query: string,
  recent: readonly string[] = [],
): SwitcherMatch[] {
  const order = new Map(recent.map((path, i) => [path, i]));
  const recency = (path: string) => order.get(path) ?? Number.POSITIVE_INFINITY;
  const q = query.trim();

  const matches: SwitcherMatch[] = [];
  for (const entry of entries) {
    const name = fileLabel(entry.path);
    if (!q) {
      matches.push({ entry, label: name, isAlias: false, score: 0, positions: [] });
      continue;
    }
    let best: SwitcherMatch | null = null;
    for (const [label, isAlias] of [
      [name, false],
      ...entry.aliases.map((a) => [a, true] as const),
    ] as const) {
      const found = fuzzyMatch(q, label);
      if (found && (!best || found.score > best.score)) {
        best = { entry, label, isAlias, score: found.score, positions: found.positions };
      }
    }
    if (best) matches.push(best);
  }

  return matches.sort(
    (a, b) =>
      b.score - a.score ||
      recency(a.entry.path) - recency(b.entry.path) ||
      a.entry.path.localeCompare(b.entry.path),
  );
}

/**
 * Splits a `root:name` (or `root:"two words"`) filter off the query (#117). `roots` are the names
 * lower-cased, `text` is the rest of the query.
 */
export function splitRootFilter(query: string): { roots: string[]; text: string } {
  const roots: string[] = [];
  const text = query
    .replace(
      /(^|\s)root:(?:"([^"]*)"|(\S*))/giu,
      (_all, lead: string, quoted?: string, bare?: string) => {
        const name = (quoted ?? bare ?? "").trim().toLowerCase();
        if (name) roots.push(name);
        return lead;
      },
    )
    .trim();
  return { roots, text };
}

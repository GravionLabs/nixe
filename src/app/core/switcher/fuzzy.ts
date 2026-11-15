export interface SwitcherEntry {
  /** Vault-relative path. */
  path: string;
  title: string;
  aliases: readonly string[];
}

export interface SwitcherMatch {
  entry: SwitcherEntry;
  /** The text that matched: the file name or one of the aliases. */
  label: string;
  isAlias: boolean;
  score: number;
}

const SEPARATORS = /[\s\-_./\\]/u;

/**
 * Fuzzy score of `query` against `text`: every query character must occur in order
 * (case-insensitive). Higher is better; null means no match. Rewards a prefix, matches at
 * word starts and consecutive runs, and penalises gaps and long texts.
 */
export function fuzzyScore(query: string, text: string): number | null {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (!q) return 0;
  if (q.length > t.length) return null;

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
    previous = at;
    from = at + 1;
  }
  if (t === q) score += 100;
  else if (t.startsWith(q)) score += 20;
  return score - t.length * 0.1;
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
export function rank(entries: readonly SwitcherEntry[], query: string, recent: readonly string[] = []): SwitcherMatch[] {
  const order = new Map(recent.map((path, i) => [path, i]));
  const recency = (path: string) => order.get(path) ?? Number.POSITIVE_INFINITY;
  const q = query.trim();

  const matches: SwitcherMatch[] = [];
  for (const entry of entries) {
    const name = fileLabel(entry.path);
    if (!q) {
      matches.push({ entry, label: name, isAlias: false, score: 0 });
      continue;
    }
    let best: SwitcherMatch | null = null;
    for (const [label, isAlias] of [[name, false], ...entry.aliases.map((a) => [a, true] as const)] as const) {
      const score = fuzzyScore(q, label);
      if (score !== null && (!best || score > best.score)) best = { entry, label, isAlias, score };
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

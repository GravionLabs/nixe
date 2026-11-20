/** Pure helpers of the keyboard handling and selection of the file tree (#231). */

export type FocusKey = "ArrowDown" | "ArrowUp" | "Home" | "End";

/** The index of the row to focus after `key`, from `index` among `count` rows (-1: none focused). */
export function focusTarget(count: number, index: number, key: FocusKey): number {
  if (count === 0) return -1;
  switch (key) {
    case "Home":
      return 0;
    case "End":
      return count - 1;
    case "ArrowDown":
      return Math.min(count - 1, index + 1);
    case "ArrowUp":
      return Math.max(0, index - 1);
  }
}

/** The index of the next row whose name starts with `query` (case-insensitive), after `from`; -1 for none. */
export function typeAheadMatch(names: readonly string[], from: number, query: string): number {
  const q = query.toLowerCase();
  if (!q) return -1;
  // A repeated letter cycles through the rows of that letter; a longer word keeps the current row.
  const repeated = [...q].every((c) => c === q[0]);
  const start = repeated ? from + 1 : Math.max(from, 0);
  const needle = repeated ? q[0] : q;
  for (let n = 0; n < names.length; n++) {
    const i = (start + n) % names.length;
    if (names[i].toLowerCase().startsWith(needle)) return i;
  }
  return -1;
}

/** The index of the parent row of the row at `index`: the nearest row above with a smaller depth; -1 at the top. */
export function parentIndex(depths: readonly number[], index: number): number {
  for (let i = index - 1; i >= 0; i--) if (depths[i] < depths[index]) return i;
  return -1;
}

/** The indexes from `a` to `b`, both included, in either direction. */
export function rangeBetween(a: number, b: number): number[] {
  const [lo, hi] = a <= b ? [a, b] : [b, a];
  return Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
}

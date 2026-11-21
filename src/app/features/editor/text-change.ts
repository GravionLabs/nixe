import type { ChangeSpec } from "@codemirror/state";

/** The one change that turns `current` into `next`: common start and end stay; null when equal. */
export function textChange(current: string, next: string): ChangeSpec | null {
  let from = 0;
  while (from < current.length && from < next.length && current[from] === next[from]) from++;
  let end = current.length;
  let nextEnd = next.length;
  while (end > from && nextEnd > from && current[end - 1] === next[nextEnd - 1]) {
    end--;
    nextEnd--;
  }
  if (from === end && from === nextEnd) return null;
  return { from, to: end, insert: next.slice(from, nextEnd) };
}

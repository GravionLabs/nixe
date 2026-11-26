import type { ChangeSpec } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";

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

/**
 * Turns the text of `view` into `next` as one change. A destroyed view takes it but runs no
 * update listeners: `unheard` stands in for them.
 */
export function dispatchText(
  view: EditorView,
  next: string,
  unheard?: (text: string) => void,
): void {
  const change = textChange(view.state.doc.toString(), next);
  if (!change) return;
  view.dispatch({ changes: change });
  unheard?.(next);
}

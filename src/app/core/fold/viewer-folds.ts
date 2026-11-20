import { hiddenBlocks } from "./fold-core";

const HIDDEN_CLASS = "fold-hidden";
const MARKER_CLASS = "fold-marker";

/** A heading of the rendered note that may fold. */
export interface HeadingFold {
  el: HTMLElement;
  /** 1-based source line, the key of the stored fold state. */
  line: number;
  /** Something follows it before the next heading of its level or a higher one. */
  foldable: boolean;
  folded: boolean;
  level: number;
}

function levelOf(el: Element): number {
  const m = /^H([1-6])$/.exec(el.tagName);
  return m && (el as HTMLElement).dataset["line"] !== undefined ? Number(m[1]) : 0;
}

/**
 * Hides the blocks under the folded headings of the rendered note and puts a marker on every
 * heading that can fold. `folded` holds 1-based source lines; lines that are no heading are ignored.
 */
export function applyHeadingFolds(root: HTMLElement, folded: ReadonlySet<number>): HeadingFold[] {
  const blocks = Array.from(root.children) as HTMLElement[];
  const levels = blocks.map(levelOf);
  const lineOf = (i: number) => Number(blocks[i]!.dataset["line"]) + 1;
  const foldable = (i: number) => levels[i]! > 0 && i + 1 < blocks.length && !(levels[i + 1]! > 0 && levels[i + 1]! <= levels[i]!);

  const closed = new Set<number>();
  blocks.forEach((_, i) => {
    if (foldable(i) && folded.has(lineOf(i))) closed.add(i);
  });
  const hidden = hiddenBlocks(levels, closed);

  const result: HeadingFold[] = [];
  blocks.forEach((el, i) => {
    el.classList.toggle(HIDDEN_CLASS, hidden.has(i));
    if (levels[i] === 0) return;
    const can = foldable(i);
    const isClosed = closed.has(i);
    const marker = el.querySelector(`:scope > .${MARKER_CLASS}`);
    if (can && !marker) {
      const span = document.createElement("span");
      span.className = MARKER_CLASS;
      span.setAttribute("aria-hidden", "true");
      el.prepend(span);
    } else if (!can) {
      marker?.remove();
    }
    el.classList.toggle("foldable", can);
    el.classList.toggle("folded", isClosed);
    if (can) el.setAttribute("aria-expanded", String(!isClosed));
    else el.removeAttribute("aria-expanded");
    result.push({ el, line: lineOf(i), foldable: can, folded: isClosed, level: levels[i]! });
  });
  return result;
}

/** The heading a fold command acts on: the nearest foldable (or folded) one at or above the top line. */
export function commandTarget(
  headings: readonly HeadingFold[],
  topLine: number | null,
  action: "fold" | "unfold",
): HeadingFold | undefined {
  const above = headings.filter((h) => topLine === null || h.line <= topLine);
  const candidates = above.length ? above : headings;
  for (let i = candidates.length - 1; i >= 0; i--) {
    const h = candidates[i]!;
    if (action === "fold" ? h.foldable && !h.folded : h.folded) return h;
  }
  return undefined;
}

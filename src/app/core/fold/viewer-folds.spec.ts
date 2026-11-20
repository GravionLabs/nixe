// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import { applyHeadingFolds, commandTarget } from "./viewer-folds";

function render(): HTMLElement {
  const root = document.createElement("div");
  root.innerHTML = [
    '<h1 data-line="0">A</h1>',
    '<p data-line="1">a</p>',
    '<h2 data-line="2">B</h2>',
    '<p data-line="3">b</p>',
    '<h1 data-line="4">C</h1>',
  ].join("");
  return root;
}

const hidden = (root: HTMLElement) =>
  Array.from(root.children).map((c) => c.classList.contains("fold-hidden"));

describe("applyHeadingFolds", () => {
  it("marks headings that have content and hides nothing by default", () => {
    const root = render();
    const h = applyHeadingFolds(root, new Set());
    expect(h.map((x) => x.foldable)).toEqual([true, true, false]);
    expect(hidden(root)).toEqual([false, false, false, false, false]);
    expect(root.querySelectorAll(".fold-marker")).toHaveLength(2);
    expect(root.children[0]!.textContent).toBe("A");
  });

  it("hides the section of a folded heading", () => {
    const root = render();
    const h = applyHeadingFolds(root, new Set([1]));
    expect(hidden(root)).toEqual([false, true, true, true, false]);
    expect(h[0]!.folded).toBe(true);
    expect(root.children[0]!.getAttribute("aria-expanded")).toBe("false");
  });

  it("ignores stored lines that are no heading and is repeatable", () => {
    const root = render();
    applyHeadingFolds(root, new Set([2, 99]));
    applyHeadingFolds(root, new Set([2]));
    expect(hidden(root)).toEqual([false, false, false, false, false]);
    expect(root.querySelectorAll(".fold-marker")).toHaveLength(2);
    applyHeadingFolds(root, new Set([3]));
    expect(hidden(root)).toEqual([false, false, false, true, false]);
  });
});

describe("commandTarget", () => {
  it("picks the nearest heading above the top line", () => {
    const h = applyHeadingFolds(render(), new Set([3]));
    expect(commandTarget(h, 4, "fold")?.line).toBe(1);
    expect(commandTarget(h, 4, "unfold")?.line).toBe(3);
    expect(commandTarget(h, 2, "fold")?.line).toBe(1);
    expect(commandTarget(h, 2, "unfold")).toBeUndefined();
  });
});

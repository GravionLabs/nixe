/** Presses an arrow key on a row of an `hx-list`; the CDK key manager reads `keyCode`. */
export function pressArrow(row: Element, key: "ArrowDown" | "ArrowUp"): void {
  const keyCode = key === "ArrowDown" ? 40 : 38;
  row.dispatchEvent(
    new KeyboardEvent("keydown", { key, keyCode, bubbles: true, cancelable: true }),
  );
}

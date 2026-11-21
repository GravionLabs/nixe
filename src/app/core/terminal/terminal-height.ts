/** Height rules of the bottom terminal panel. No Angular, no DOM. */

export const DEFAULT_TERMINAL_HEIGHT = 240;
export const MIN_TERMINAL_HEIGHT = 80;
/** The note keeps at least this much room above the panel. */
export const MIN_NOTE_HEIGHT = 160;
/** Toolbar, status bar and borders around the content. */
export const TERMINAL_CHROME = 72;

/** The tallest the panel may be for a window of `windowHeight`. */
export function maxTerminalHeight(windowHeight: number): number {
  return Math.max(MIN_TERMINAL_HEIGHT, windowHeight - TERMINAL_CHROME - MIN_NOTE_HEIGHT);
}

export function clampTerminalHeight(height: number, windowHeight: number): number {
  return Math.round(
    Math.min(maxTerminalHeight(windowHeight), Math.max(MIN_TERMINAL_HEIGHT, height)),
  );
}

/** The height after a key on the separator (the panel grows upwards), or null for a key it ignores. */
export function heightAfterKey(
  key: string,
  shift: boolean,
  height: number,
  windowHeight: number,
): number | null {
  const step = shift ? 64 : 16;
  let next: number;
  if (key === "ArrowUp") next = height + step;
  else if (key === "ArrowDown") next = height - step;
  else if (key === "Home") next = MIN_TERMINAL_HEIGHT;
  else if (key === "End") next = maxTerminalHeight(windowHeight);
  else return null;
  return clampTerminalHeight(next, windowHeight);
}

/** Reads a stored height defensively. */
export function sanitizeTerminalHeight(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(4000, Math.max(MIN_TERMINAL_HEIGHT, Math.round(value)))
    : DEFAULT_TERMINAL_HEIGHT;
}

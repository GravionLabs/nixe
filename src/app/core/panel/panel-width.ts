/** Width rules of the right panel. No Angular, no DOM. */

export const DEFAULT_PANEL_WIDTH = 280;
export const MIN_PANEL_WIDTH = 180;
export const MAX_PANEL_WIDTH = 640;
/** The note keeps at least this much room. */
export const MIN_NOTE_WIDTH = 320;
/** Activity bar, frame gaps and borders around the note and the panels. */
export const SHELL_CHROME = 72;
/** Width of the grab area of the edge. */
export const GRAB_WIDTH = 6;

/** Pixels the window leaves for the panel when the note keeps `MIN_NOTE_WIDTH`. */
function room(windowWidth: number, sidebarWidth: number): number {
  return windowWidth - sidebarWidth - SHELL_CHROME - MIN_NOTE_WIDTH;
}

/** The widest the panel may be without squeezing the note under `MIN_NOTE_WIDTH`. */
export function maxPanelWidth(windowWidth: number, sidebarWidth: number): number {
  return Math.max(MIN_PANEL_WIDTH, Math.min(MAX_PANEL_WIDTH, room(windowWidth, sidebarWidth)));
}

export function clampPanelWidth(width: number, windowWidth: number, sidebarWidth: number): number {
  return Math.round(Math.min(maxPanelWidth(windowWidth, sidebarWidth), Math.max(MIN_PANEL_WIDTH, width)));
}

/** True when the window is too narrow to show the panel next to a note of `MIN_NOTE_WIDTH`: the panel then overlays it. */
export function overlaysNote(windowWidth: number, sidebarWidth: number): boolean {
  return room(windowWidth, sidebarWidth) < MIN_PANEL_WIDTH;
}

/** The width after a key on the separator (the panel grows to the left), or null for a key it ignores. */
export function widthAfterKey(key: string, shift: boolean, width: number, windowWidth: number, sidebarWidth: number): number | null {
  const step = shift ? 64 : 16;
  let next: number;
  if (key === "ArrowLeft") next = width + step;
  else if (key === "ArrowRight") next = width - step;
  else if (key === "Home") next = MIN_PANEL_WIDTH;
  else if (key === "End") next = MAX_PANEL_WIDTH;
  else return null;
  return clampPanelWidth(next, windowWidth, sidebarWidth);
}

/** Reads a stored width defensively. */
export function sanitizePanelWidth(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(MAX_PANEL_WIDTH, Math.max(MIN_PANEL_WIDTH, Math.round(value)))
    : DEFAULT_PANEL_WIDTH;
}

import { describe, expect, it } from "vitest";

import {
  DEFAULT_PANEL_WIDTH,
  MAX_PANEL_WIDTH,
  MIN_NOTE_WIDTH,
  MIN_PANEL_WIDTH,
  SHELL_CHROME,
  clampPanelWidth,
  maxPanelWidth,
  overlaysNote,
  sanitizePanelWidth,
  widthAfterKey,
} from "./panel-width";

describe("panel width", () => {
  it("leaves the note at least 320px", () => {
    for (const win of [900, 1200, 1600]) {
      const width = clampPanelWidth(10_000, win, 260);
      expect(win - 260 - SHELL_CHROME - width).toBeGreaterThanOrEqual(MIN_NOTE_WIDTH);
    }
  });

  it("clamps to the minimum and the maximum", () => {
    expect(clampPanelWidth(10, 2000, 260)).toBe(MIN_PANEL_WIDTH);
    expect(clampPanelWidth(5000, 4000, 260)).toBe(MAX_PANEL_WIDTH);
    expect(maxPanelWidth(260 + SHELL_CHROME + MIN_NOTE_WIDTH + MIN_PANEL_WIDTH, 260)).toBe(MIN_PANEL_WIDTH);
  });

  it("overlays the note in a window too narrow for both", () => {
    expect(overlaysNote(1400, 260)).toBe(false);
    expect(overlaysNote(260 + SHELL_CHROME + MIN_NOTE_WIDTH + MIN_PANEL_WIDTH - 1, 260)).toBe(true);
    expect(overlaysNote(700, 260)).toBe(true);
    expect(overlaysNote(700, 0)).toBe(false);
  });

  it("keeps the stored width usable in an overlay-sized window", () => {
    expect(maxPanelWidth(600, 260)).toBe(552);
    expect(clampPanelWidth(500, 600, 260)).toBe(500);
    expect(clampPanelWidth(9999, 600, 260)).toBe(552);
    expect(clampPanelWidth(400, 200, 0)).toBe(152);
  });

  it("moves by arrow keys, the panel growing to the left", () => {
    expect(widthAfterKey("ArrowLeft", false, 280, 2000, 260)).toBe(296);
    expect(widthAfterKey("ArrowRight", false, 280, 2000, 260)).toBe(264);
    expect(widthAfterKey("ArrowLeft", true, 280, 2000, 260)).toBe(344);
    expect(widthAfterKey("Home", false, 280, 2000, 260)).toBe(MIN_PANEL_WIDTH);
    expect(widthAfterKey("End", false, 280, 4000, 260)).toBe(MAX_PANEL_WIDTH);
    expect(widthAfterKey("a", false, 280, 2000, 260)).toBeNull();
  });

  it("reads a stored width defensively", () => {
    expect(sanitizePanelWidth("x")).toBe(DEFAULT_PANEL_WIDTH);
    expect(sanitizePanelWidth(NaN)).toBe(DEFAULT_PANEL_WIDTH);
    expect(sanitizePanelWidth(1)).toBe(MIN_PANEL_WIDTH);
    expect(sanitizePanelWidth(9999)).toBe(MAX_PANEL_WIDTH);
    expect(sanitizePanelWidth(333.4)).toBe(333);
  });
});

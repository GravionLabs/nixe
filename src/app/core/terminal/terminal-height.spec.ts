import { describe, expect, it } from "vitest";

import {
  DEFAULT_TERMINAL_HEIGHT,
  MIN_TERMINAL_HEIGHT,
  clampTerminalHeight,
  heightAfterKey,
  maxTerminalHeight,
  sanitizeTerminalHeight,
} from "./terminal-height";

describe("terminal height", () => {
  it("keeps the note room above the panel", () => {
    expect(maxTerminalHeight(1000)).toBe(768);
    expect(maxTerminalHeight(100)).toBe(MIN_TERMINAL_HEIGHT);
  });

  it("clamps between the minimum and the maximum", () => {
    expect(clampTerminalHeight(10, 1000)).toBe(MIN_TERMINAL_HEIGHT);
    expect(clampTerminalHeight(5000, 1000)).toBe(768);
    expect(clampTerminalHeight(300.4, 1000)).toBe(300);
  });

  it("grows upwards with the arrow keys", () => {
    expect(heightAfterKey("ArrowUp", false, 240, 1000)).toBe(256);
    expect(heightAfterKey("ArrowDown", true, 240, 1000)).toBe(176);
    expect(heightAfterKey("Home", false, 240, 1000)).toBe(MIN_TERMINAL_HEIGHT);
    expect(heightAfterKey("End", false, 240, 1000)).toBe(768);
    expect(heightAfterKey("x", false, 240, 1000)).toBeNull();
  });

  it("reads a stored height defensively", () => {
    expect(sanitizeTerminalHeight("tall")).toBe(DEFAULT_TERMINAL_HEIGHT);
    expect(sanitizeTerminalHeight(NaN)).toBe(DEFAULT_TERMINAL_HEIGHT);
    expect(sanitizeTerminalHeight(1)).toBe(MIN_TERMINAL_HEIGHT);
    expect(sanitizeTerminalHeight(250.6)).toBe(251);
  });
});

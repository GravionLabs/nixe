import { describe, expect, it } from "vitest";

import { LOG_LEVELS, sanitizeLogLevel } from "./log-level";

describe("sanitizeLogLevel", () => {
  it("keeps the four levels", () => {
    for (const level of LOG_LEVELS) expect(sanitizeLogLevel(level)).toBe(level);
  });

  it("falls back to info", () => {
    for (const bad of ["trace", "INFO", "", null, undefined, 4])
      expect(sanitizeLogLevel(bad)).toBe("info");
  });
});

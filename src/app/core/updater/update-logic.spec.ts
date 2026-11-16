import { describe, expect, it } from "vitest";

import { downloadPercent, failureMessage, isOfferable, isPrerelease } from "./update-logic";

describe("update logic", () => {
  it("recognises pre-releases", () => {
    expect(isPrerelease("1.1.0-rc021")).toBe(true);
    expect(isPrerelease("v1.1.0-rc.1+5")).toBe(true);
    expect(isPrerelease("1.1.0")).toBe(false);
    expect(isPrerelease("1.1.0+build-5")).toBe(false);
  });

  it("does not offer a pre-release to a stable install", () => {
    expect(isOfferable("1.0.0", "1.1.0-rc1")).toBe(false);
    expect(isOfferable("1.0.0", "1.1.0")).toBe(true);
    expect(isOfferable("1.1.0-rc1", "1.1.0-rc2")).toBe(true);
  });

  it("names the failed step", () => {
    expect(failureMessage("check", new Error("offline"))).toBe("Check for updates failed: offline");
    expect(failureMessage("update", "bad signature")).toBe("Update failed: bad signature");
    expect(failureMessage("update", "")).toBe("Update failed");
  });

  it("computes the download percentage", () => {
    expect(downloadPercent(50, 200)).toBe(25);
    expect(downloadPercent(300, 200)).toBe(100);
    expect(downloadPercent(5, null)).toBeNull();
    expect(downloadPercent(5, 0)).toBeNull();
  });
});

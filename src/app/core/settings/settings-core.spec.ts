import { describe, expect, it } from "vitest";

import { DEFAULT_SETTINGS, loadSettings, sanitizeSettings, serializeSettings } from "./settings-core";

describe("sanitizeSettings", () => {
  it("gives defaults for anything that is not an object", () => {
    for (const raw of [null, undefined, 3, "x", [1]]) expect(sanitizeSettings(raw)).toEqual(DEFAULT_SETTINGS);
  });

  it("keeps valid values and replaces wrong types, per key", () => {
    const s = sanitizeSettings({
      theme: "dark",
      math: "yes",
      zoom: 500,
      autoSyncMinutes: "x",
      healthExclude: ["a", 1, "b"],
      recentVaults: "nope",
      gitAuthorName: "Ada",
      lastFolder: 7,
    });
    expect(s.theme).toBe("dark");
    expect(s.math).toBe(true);
    expect(s.zoom).toBe(300);
    expect(s.healthExclude).toEqual(["a", "b"]);
    expect(s.recentVaults).toEqual([]);
    expect(s.gitAuthorName).toBe("Ada");
    expect(s.lastFolder).toBeNull();
    expect(s.autoSyncMinutes).toBeGreaterThanOrEqual(1);
  });

  it("round-trips through the file text", () => {
    const s = sanitizeSettings({ theme: "light", sidebar: false, recentVaults: ["/v"], dailyFormat: "YYYY" });
    expect(sanitizeSettings(JSON.parse(serializeSettings(s)))).toEqual(s);
  });
});

describe("loadSettings (migration from the localStorage SettingsService)", () => {
  const legacy = JSON.stringify({ theme: "dark", lastFolder: "/vault", recentVaults: ["/vault"], zoom: 120 });

  it("takes the settings file when there is one, ignoring the old entry", () => {
    const r = loadSettings(JSON.stringify({ theme: "light" }), legacy);
    expect(r.source).toBe("file");
    expect(r.settings.theme).toBe("light");
    expect(r.settings.lastFolder).toBeNull();
  });

  it("migrates the old entry when there is no file", () => {
    const r = loadSettings(null, legacy);
    expect(r.source).toBe("legacy");
    expect(r.settings).toMatchObject({ theme: "dark", lastFolder: "/vault", recentVaults: ["/vault"], zoom: 120 });
    expect(r.settings.math).toBe(true);
  });

  it("migrates an old entry written by an older version (missing keys get defaults)", () => {
    const r = loadSettings(null, JSON.stringify({ theme: "dark" }));
    expect(r.settings).toEqual({ ...DEFAULT_SETTINGS, theme: "dark" });
  });

  it("falls back to the old entry when the file is damaged", () => {
    expect(loadSettings("{broken", legacy).source).toBe("legacy");
    expect(loadSettings("[]", legacy).source).toBe("legacy");
  });

  it("uses the defaults when there is nothing", () => {
    expect(loadSettings(null, null)).toEqual({ settings: DEFAULT_SETTINGS, source: "defaults", damaged: false });
    expect(loadSettings("x", "y").source).toBe("defaults");
    expect(loadSettings("{broken", legacy).damaged).toBe(true);
    expect(loadSettings(null, legacy).damaged).toBe(false);
  });
});

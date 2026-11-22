import { describe, expect, it } from "vitest";

import {
  DEFAULT_SETTINGS,
  loadSettings,
  sanitizeSettings,
  serializeSettings,
} from "./settings-core";

describe("sanitizeSettings", () => {
  it("gives defaults for anything that is not an object", () => {
    for (const raw of [null, undefined, 3, "x", [1]])
      expect(sanitizeSettings(raw)).toEqual(DEFAULT_SETTINGS);
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
      reviewBranchPrefix: 5,
    });
    expect(s.reviewBranchPrefix).toBe("claude/");
    expect(s.bookmarksInVault).toBe(false);
    expect(s.extractEmbed).toBe(false);
    expect(sanitizeSettings({ extractEmbed: true }).extractEmbed).toBe(true);
    expect(sanitizeSettings({ extractEmbed: 1 }).extractEmbed).toBe(false);
    expect(s.wrapCode).toBe(false);
    expect(sanitizeSettings({ wrapCode: true }).wrapCode).toBe(true);
    expect(sanitizeSettings({ wrapCode: "yes" }).wrapCode).toBe(false);
    expect(s.previewTabs).toBe(true);
    expect(sanitizeSettings({ previewTabs: false }).previewTabs).toBe(false);
    expect(sanitizeSettings({ previewTabs: "no" }).previewTabs).toBe(true);
    expect(s.exportPageBreaks).toBe(true);
    expect(s.exportDark).toBe(false);
    expect(s.exportPageSize).toBe("A4");
    expect(sanitizeSettings({ exportPageBreaks: false }).exportPageBreaks).toBe(false);
    expect(sanitizeSettings({ exportPageBreaks: "no" }).exportPageBreaks).toBe(true);
    expect(sanitizeSettings({ exportDark: true }).exportDark).toBe(true);
    expect(sanitizeSettings({ exportPageSize: "legal" }).exportPageSize).toBe("Legal");
    expect(sanitizeSettings({ exportPageSize: "B7" }).exportPageSize).toBe("A4");
    expect(s.treeGitStatus).toBe(true);
    expect(sanitizeSettings({ treeGitStatus: false }).treeGitStatus).toBe(false);
    expect(sanitizeSettings({ treeGitStatus: "no" }).treeGitStatus).toBe(true);
    // The terminal is opt-in: only an explicit true turns anything on.
    expect(s.terminalEnabled).toBe(false);
    expect(s.terminalConfirmed).toBe(false);
    expect(s.terminalVisible).toBe(false);
    expect(s.terminalHeight).toBe(240);
    const t = sanitizeSettings({
      terminalEnabled: true,
      terminalConfirmed: true,
      terminalVisible: true,
      terminalHeight: 300,
    });
    expect([t.terminalEnabled, t.terminalConfirmed, t.terminalVisible, t.terminalHeight]).toEqual([
      true,
      true,
      true,
      300,
    ]);
    expect(sanitizeSettings({ terminalEnabled: "yes" }).terminalEnabled).toBe(false);
    expect(s.captureShortcut).toBe("");
    expect(s.captureTarget).toBe("daily");
    expect(
      sanitizeSettings({
        captureShortcut: " Alt+Space ",
        captureTarget: "inbox",
        captureInbox: "In",
      }),
    ).toMatchObject({ captureShortcut: "Alt+Space", captureTarget: "inbox", captureInbox: "In" });
    expect(sanitizeSettings({ captureTarget: "x", captureShortcut: 3 })).toMatchObject({
      captureTarget: "daily",
      captureShortcut: "",
    });
    expect(s.propertiesDisplay).toBe("hidden");
    expect(s.defaultView).toBe("live");
    expect(sanitizeSettings({ defaultView: "reading" }).defaultView).toBe("reading");
    expect(sanitizeSettings({ defaultView: "source" }).defaultView).toBe("source");
    expect(sanitizeSettings({ defaultView: "x" }).defaultView).toBe("live");
    // The former flag migrates; the new key wins.
    expect(sanitizeSettings({ sourceMode: true }).defaultView).toBe("source");
    expect(sanitizeSettings({ sourceMode: false }).defaultView).toBe("live");
    expect(sanitizeSettings({ sourceMode: true, defaultView: "reading" }).defaultView).toBe(
      "reading",
    );
    expect(sanitizeSettings({ propertiesDisplay: "visible" }).propertiesDisplay).toBe("visible");
    expect(sanitizeSettings({ propertiesDisplay: "folded" }).propertiesDisplay).toBe("folded");
    expect(sanitizeSettings({ propertiesDisplay: "hidden" }).propertiesDisplay).toBe("hidden");
    expect(sanitizeSettings({ propertiesDisplay: "x" }).propertiesDisplay).toBe("hidden");
    expect(s.treeSort).toBe("name-asc");
    expect(sanitizeSettings({ treeSort: "modified-desc" }).treeSort).toBe("modified-desc");
    expect(sanitizeSettings({ treeSort: "bogus" }).treeSort).toBe("name-asc");
    expect(s.appearanceTheme).toBe("");
    expect(s.snippets).toEqual([]);
    expect(s.accentColor).toBe("");
    const a = sanitizeSettings({
      appearanceTheme: "sepia",
      snippets: ["a", 1, "a"],
      accentColor: "#ABC",
      fontText: "Inter",
      fontMono: "a;b",
    });
    expect([a.appearanceTheme, a.snippets, a.accentColor, a.fontText, a.fontMono]).toEqual([
      "sepia",
      ["a"],
      "#aabbcc",
      "Inter",
      "",
    ]);
    expect(sanitizeSettings({ bookmarksInVault: true }).bookmarksInVault).toBe(true);
    expect(sanitizeSettings({ bookmarksInVault: "yes" }).bookmarksInVault).toBe(false);
    expect(sanitizeSettings({ reviewBranchPrefix: "agent/" }).reviewBranchPrefix).toBe("agent/");
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
    const s = sanitizeSettings({
      theme: "light",
      sidebar: false,
      recentVaults: ["/v"],
      dailyFormat: "YYYY",
    });
    expect(sanitizeSettings(JSON.parse(serializeSettings(s)))).toEqual(s);
  });
});

describe("loadSettings (migration from the localStorage SettingsService)", () => {
  const legacy = JSON.stringify({
    theme: "dark",
    lastFolder: "/vault",
    recentVaults: ["/vault"],
    zoom: 120,
  });

  it("takes the settings file when there is one, ignoring the old entry", () => {
    const r = loadSettings(JSON.stringify({ theme: "light" }), legacy);
    expect(r.source).toBe("file");
    expect(r.settings.theme).toBe("light");
    expect(r.settings.lastFolder).toBeNull();
  });

  it("migrates the old entry when there is no file", () => {
    const r = loadSettings(null, legacy);
    expect(r.source).toBe("legacy");
    expect(r.settings).toMatchObject({
      theme: "dark",
      lastFolder: "/vault",
      recentVaults: ["/vault"],
      zoom: 120,
    });
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
    expect(loadSettings(null, null)).toEqual({
      settings: DEFAULT_SETTINGS,
      source: "defaults",
      damaged: false,
    });
    expect(loadSettings("x", "y").source).toBe("defaults");
    expect(loadSettings("{broken", legacy).damaged).toBe(true);
    expect(loadSettings(null, legacy).damaged).toBe(false);
  });
});

describe("textSize setting", () => {
  it("is 14 for a settings file without the key", () => {
    expect(sanitizeSettings({}).textSize).toBe(14);
    expect(sanitizeSettings({ zoom: 120 }).textSize).toBe(14);
  });

  it("is kept within 10 to 24 px", () => {
    expect(sanitizeSettings({ textSize: 18 }).textSize).toBe(18);
    expect(sanitizeSettings({ textSize: 2 }).textSize).toBe(10);
    expect(sanitizeSettings({ textSize: 99 }).textSize).toBe(24);
    expect(sanitizeSettings({ textSize: "big" }).textSize).toBe(14);
  });
});

describe("shortcuts setting", () => {
  it("defaults to none and keeps only string overrides", () => {
    expect(sanitizeSettings(null).shortcuts).toEqual({});
    expect(sanitizeSettings({ shortcuts: { a: "Mod+K", b: 1, c: "" } }).shortcuts).toEqual({
      a: "Mod+K",
      c: "",
    });
    expect(sanitizeSettings({ shortcuts: "Mod+K" }).shortcuts).toEqual({});
  });
});

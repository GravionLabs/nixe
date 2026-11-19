import { describe, expect, it } from "vitest";

import { DEFAULT_VIEW, VIEWS, availableViews, findView, isSidebarView, resolveView } from "./views";

describe("views registry", () => {
  it("declares every view once, with a label, an icon and a placement", () => {
    expect(new Set(VIEWS.map((v) => v.id)).size).toBe(VIEWS.length);
    for (const v of VIEWS) {
      expect(v.label).not.toBe("");
      expect(typeof v.icon).toBe("string");
      expect(["sidebar", "tab"]).toContain(v.placement);
    }
  });

  it("puts files, search, Git, history and health at the top, settings at the bottom; outline and backlinks are not in it", () => {
    const top = VIEWS.filter((v) => v.position === "top").map((v) => v.id);
    expect(top.slice(0, 5)).toEqual(["files", "search", "git", "history", "health"]);
    expect(top).toEqual(expect.arrayContaining(["daily-note", "command-palette"]));
    expect(VIEWS.filter((v) => v.position === "bottom").map((v) => v.id)).toEqual(["settings"]);
    expect(findView("outline")).toBeUndefined();
    expect(findView("backlinks")).toBeUndefined();
  });

  it("fills the sidebar with files, search, Git and the note history; health is a tab, the rest are actions", () => {
    expect(VIEWS.filter((v) => isSidebarView(v.id)).map((v) => v.id)).toEqual(["files", "search", "git", "history"]);
    expect(findView("health")?.placement).toBe("tab");
    expect(findView("daily-note")?.kind).toBe("action");
    expect(findView("settings")?.command).toBe("open-settings");
  });

  it("offers only what the vault allows", () => {
    const ids = (vault: boolean, git: boolean) => availableViews({ vault, git }).map((v) => v.id);
    expect(ids(false, false)).toEqual(["files", "command-palette", "settings"]);
    expect(ids(true, false)).not.toContain("git");
    expect(ids(true, false)).not.toContain("history");
    expect(ids(true, true)).toContain("history");
    expect(ids(true, true)).toContain("git");
  });

  it("resolves an unknown or unavailable view to the files", () => {
    expect(resolveView("search", { vault: true, git: false })).toBe("search");
    expect(resolveView("git", { vault: true, git: false })).toBe(DEFAULT_VIEW);
    expect(resolveView("search", { vault: false, git: false })).toBe(DEFAULT_VIEW);
    expect(resolveView("nope", { vault: true, git: true })).toBe(DEFAULT_VIEW);
    expect(resolveView("health", { vault: true, git: true })).toBe(DEFAULT_VIEW);
  });
});

// @vitest-environment jsdom
import "@angular/compiler";
import { TestBed } from "@angular/core/testing";
import { BrowserTestingModule, platformBrowserTesting } from "@angular/platform-browser/testing";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { SettingItem, SettingsRegistry, ShownSection, filterSections } from "./settings-registry";

const toggle = (id: string, label: string, extra: Partial<SettingItem> = {}): SettingItem =>
  ({ kind: "toggle", id, label, get: () => false, set: () => undefined, ...extra }) as SettingItem;

const sections: ShownSection[] = [
  { id: "a", title: "Appearance", items: [toggle("theme", "Theme", { keywords: ["dark"] }), toggle("zoom", "Zoom", { description: "Page size" })] },
  { id: "g", title: "Git", items: [toggle("sync", "Sync automatically")] },
];

describe("filterSections", () => {
  it("returns everything for an empty query", () => {
    expect(filterSections(sections, "  ")).toEqual(sections);
  });

  it("matches label, description and keywords, case-insensitively", () => {
    expect(filterSections(sections, "THEME").map((s) => s.items.map((i) => i.id))).toEqual([["theme"]]);
    expect(filterSections(sections, "dark")[0].items[0].id).toBe("theme");
    expect(filterSections(sections, "size")[0].items[0].id).toBe("zoom");
  });

  it("matches the section title and needs every word", () => {
    expect(filterSections(sections, "git")).toHaveLength(1);
    expect(filterSections(sections, "git sync")[0].items).toHaveLength(1);
    expect(filterSections(sections, "git zoom")).toEqual([]);
  });
});

describe("SettingsRegistry", () => {
  let registry: SettingsRegistry;

  beforeAll(() => TestBed.initTestEnvironment(BrowserTestingModule, platformBrowserTesting()));
  beforeEach(() => {
    TestBed.resetTestingModule();
    registry = TestBed.inject(SettingsRegistry);
  });

  it("lists sections by order, then title, and later features can add their own", () => {
    registry.register({ id: "z", title: "Zed", order: 5, items: () => [] });
    registry.register({ id: "b", title: "Beta", items: () => [] });
    registry.register({ id: "a", title: "Alpha", items: () => [] });
    expect(registry.sections().map((s) => s.id)).toEqual(["z", "a", "b"]);
  });

  it("replaces a section of the same id and unregisters", () => {
    registry.register({ id: "x", title: "One", items: () => [] });
    const remove = registry.register({ id: "x", title: "Two", items: () => [toggle("t", "T")] });
    expect(registry.shown()).toEqual([{ id: "x", title: "Two", items: [expect.objectContaining({ id: "t" })] }]);
    remove();
    expect(registry.sections()).toEqual([]);
  });
});

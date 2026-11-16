// @vitest-environment jsdom
import "@angular/compiler";
import { signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { BrowserTestingModule, platformBrowserTesting } from "@angular/platform-browser/testing";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { CommandRegistry } from "../commands/command-registry";
import { backend } from "../file/backend";
import { WorkspaceService } from "../workspace/workspace.service";
import { builtinSections, parseList } from "./builtin-sections";
import { SettingsPageService } from "./settings-page.service";
import { SettingsRegistry } from "./settings-registry";
import { SettingsService } from "./settings.service";

describe("settings page", () => {
  const vaultRoot = signal<string | null>(null);
  const obsidian = vi.spyOn(backend, "obsidianSettings");
  let page: SettingsPageService;
  let settings: SettingsService;

  beforeAll(() => TestBed.initTestEnvironment(BrowserTestingModule, platformBrowserTesting()));

  beforeEach(() => {
    vaultRoot.set(null);
    obsidian.mockReset();
    window.matchMedia = (() => ({ matches: false, addEventListener: () => undefined })) as unknown as typeof window.matchMedia;
    localStorage.clear();
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ providers: [{ provide: WorkspaceService, useValue: { vaultRoot } }] });
    settings = TestBed.inject(SettingsService);
    TestBed.inject(CommandRegistry).register({ id: "x", title: "Do x", shortcut: "Mod+,", run: () => undefined });
    page = TestBed.inject(SettingsPageService);
  });

  it("registers the six sections in order", () => {
    expect(TestBed.inject(SettingsRegistry).sections().map((s) => s.title)).toEqual([
      "General",
      "Editor",
      "Files and links",
      "Appearance",
      "Git",
      "Shortcuts",
    ]);
  });

  it("changes apply to the settings at once", () => {
    const theme = TestBed.inject(SettingsRegistry).shown().flatMap((s) => s.items).find((i) => i.id === "theme")!;
    if (theme.kind !== "select") throw new Error("select expected");
    theme.set("dark");
    expect(settings.themeMode()).toBe("dark");
    expect(theme.get()).toBe("dark");
  });

  it("shows the Obsidian settings read-only with their source", async () => {
    vaultRoot.set("/v");
    obsidian.mockResolvedValue([
      { id: "template-folder", label: "Template folder", value: "T", source: ".obsidian/templates.json" },
      { id: "daily-folder", label: "Daily notes folder", value: null, source: ".obsidian/daily-notes.json" },
    ]);
    await page.open();
    const items = page.sections().find((s) => s.id === "files")!.items;
    const tpl = items.find((i) => i.id === "obsidian-template-folder")!;
    const daily = items.find((i) => i.id === "obsidian-daily-folder")!;
    if (tpl.kind !== "readonly" || daily.kind !== "readonly") throw new Error("readonly expected");
    expect(tpl.value()).toBe("T");
    expect(tpl.source?.()).toBe(".obsidian/templates.json");
    expect(daily.value()).toBe("Not set");
  });

  it("says that a vault is needed when none is open", async () => {
    await page.open();
    expect(obsidian).not.toHaveBeenCalled();
    const item = page.sections().find((s) => s.id === "files")!.items[0];
    expect(item.id).toBe("obsidian-none");
  });

  it("filters the settings with the search field and lists the selected section otherwise", async () => {
    await page.open();
    expect(page.listed().map((s) => s.id)).toEqual(["general"]);
    page.select("git");
    expect(page.listed().map((s) => s.id)).toEqual(["git"]);
    page.query.set("theme");
    expect(page.listed().map((s) => [s.id, s.items.map((i) => i.id)])).toEqual([["appearance", ["theme"]]]);
    page.query.set("zzz");
    expect(page.listed()).toEqual([]);
  });

  it("lists the shortcuts of the commands", () => {
    const items = page.sections().find((s) => s.id === "shortcuts")!.items;
    expect(items.map((i) => i.label)).toEqual(["Do x"]);
  });

  it("parses comma separated lists", () => {
    expect(parseList(" a, b ,,c ")).toEqual(["a", "b", "c"]);
    expect(parseList("")).toEqual([]);
    expect(typeof builtinSections).toBe("function");
  });
});

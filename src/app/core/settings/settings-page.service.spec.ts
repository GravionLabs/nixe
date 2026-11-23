// @vitest-environment jsdom
import "@angular/compiler";
import { signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { BrowserTestingModule, platformBrowserTesting } from "@angular/platform-browser/testing";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const ask = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ ask }));

import { AppearanceService } from "../appearance/appearance.service";
import { CommandRegistry } from "../commands/command-registry";
import { LogActionsService } from "../log/log-actions.service";
import { backend } from "../file/backend";
import { provideHxAppInfo } from "@gravionlabs/helix-desktop/tauri";
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
    ask.mockReset();
    window.matchMedia = (() => ({
      matches: false,
      addEventListener: () => undefined,
    })) as unknown as typeof window.matchMedia;
    localStorage.clear();
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        { provide: WorkspaceService, useValue: { vaultRoot } },
        provideHxAppInfo({ version: "1.4.0" }),
      ],
    });
    settings = TestBed.inject(SettingsService);
    TestBed.inject(CommandRegistry).register({
      id: "x",
      title: "Do x",
      shortcut: "Mod+,",
      run: () => undefined,
    });
    TestBed.inject(CommandRegistry).register({ id: "a", title: "Do a", run: () => undefined });
    page = TestBed.inject(SettingsPageService);
  });

  it("registers the sections in order", () => {
    expect(
      TestBed.inject(SettingsRegistry)
        .sections()
        .map((s) => s.title),
    ).toEqual([
      "General",
      "Editor",
      "Export and print",
      "Files and links",
      "Capture",
      "Appearance",
      "Sync",
      "Terminal",
      "Shortcuts",
    ]);
  });

  it("shows the running version read-only in General", () => {
    const item = TestBed.inject(SettingsRegistry)
      .shown()
      .flatMap((s) => s.items)
      .find((i) => i.id === "version")!;
    if (item.kind !== "readonly") throw new Error("readonly expected");
    expect(item.value()).toBe("1.4.0");
  });

  it("changes apply to the settings at once", () => {
    const theme = TestBed.inject(SettingsRegistry)
      .shown()
      .flatMap((s) => s.items)
      .find((i) => i.id === "theme")!;
    if (theme.kind !== "select") throw new Error("select expected");
    theme.set("dark");
    expect(settings.themeMode()).toBe("dark");
    expect(theme.get()).toBe("dark");
  });

  it("lists the themes, switches a theme and each snippet, and sets accent and fonts (#114)", async () => {
    const appearance = TestBed.inject(AppearanceService);
    appearance.themes.set([{ name: "sepia", modified: 1, css: "" }]);
    appearance.snippets.set([
      { name: "wide", modified: 1, css: "" },
      { name: "round", modified: 1, css: "" },
    ]);
    const items = () =>
      TestBed.inject(SettingsRegistry)
        .shown()
        .find((s) => s.id === "appearance")!.items;
    const item = (id: string) => items().find((i) => i.id === id)!;

    const theme = item("theme-file");
    if (theme.kind !== "select") throw new Error("select expected");
    expect(theme.options.map((o) => o.value)).toEqual(["", "sepia"]);
    theme.set("sepia");
    expect(settings.appearanceTheme()).toBe("sepia");

    const wide = item("snippet-wide");
    if (wide.kind !== "toggle") throw new Error("toggle expected");
    wide.set(true);
    (item("snippet-round") as { set(v: boolean): void }).set(true);
    wide.set(false);
    expect(settings.snippets()).toEqual(["round"]);
    expect(wide.get()).toBe(false);

    (item("accent-color") as { set(v: string): void }).set("#ABCDEF");
    (item("font-text") as { set(v: string): void }).set("Inter");
    (item("font-mono") as { set(v: string): void }).set("a;b");
    (item("text-size") as { set(v: number): void }).set(40);
    expect(settings.textSize()).toBe(24);
    (item("text-size") as { set(v: number): void }).set(16);
    expect(settings.textSize()).toBe(16);
    expect([settings.accentColor(), settings.fontText(), settings.fontMono()]).toEqual([
      "#abcdef",
      "Inter",
      "",
    ]);
  });

  it("shows the Obsidian settings read-only with their source", async () => {
    vaultRoot.set("/v");
    obsidian.mockResolvedValue([
      {
        id: "template-folder",
        label: "Template folder",
        value: "T",
        source: ".obsidian/templates.json",
      },
      {
        id: "daily-folder",
        label: "Daily notes folder",
        value: null,
        source: ".obsidian/daily-notes.json",
      },
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

  it("shows `.nixe/config.json` as the source where it sets a value", async () => {
    vaultRoot.set("/v");
    obsidian.mockResolvedValue([
      {
        id: "template-folder",
        label: "Template folder",
        value: "Vorlagen",
        source: ".nixe/config.json",
      },
      {
        id: "daily-format",
        label: "Daily notes date format",
        value: "YYYY-MM-DD",
        source: ".obsidian/daily-notes.json",
      },
    ]);
    await page.open();
    const items = page.sections().find((s) => s.id === "files")!.items;
    const tpl = items.find((i) => i.id === "obsidian-template-folder")!;
    const format = items.find((i) => i.id === "obsidian-daily-format")!;
    if (tpl.kind !== "readonly" || format.kind !== "readonly") throw new Error("readonly expected");
    expect(tpl.source?.()).toBe(".nixe/config.json");
    expect(tpl.description).toContain(".nixe/config.json");
    expect(format.source?.()).toBe(".obsidian/daily-notes.json");
    expect(format.description).toContain(".obsidian/");
    const own = items.find((i) => i.id === "template-folder")!;
    expect(own.description).toContain(".nixe/config.json");
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
    page.select("sync");
    expect(page.listed().map((s) => s.id)).toEqual(["sync"]);
    page.query.set("dark");
    expect(page.listed().map((s) => [s.id, s.items.map((i) => i.id)])).toEqual([
      ["export", ["export-dark"]],
      ["appearance", ["theme"]],
    ]);
    page.query.set("zzz");
    expect(page.listed()).toEqual([]);
  });

  it("has the Sync section with automatic sync, the token and the author, and search finds them", () => {
    const ids = page
      .sections()
      .find((s) => s.id === "sync")!
      .items.map((i) => i.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        "git-token",
        "git-author-name",
        "git-author-email",
        "auto-sync",
        "auto-sync-minutes",
        "auto-sync-focus",
        "auto-sync-quit",
      ]),
    );
    const found = (q: string) => {
      page.query.set(q);
      return page.listed().flatMap((s) => s.items.map((i) => i.id));
    };
    expect(found("token")).toContain("git-token");
    expect(found("keychain")).toContain("git-token");
    expect(found("author")).toEqual(
      expect.arrayContaining(["git-author-name", "git-author-email"]),
    );
    expect(found("interval")).toContain("auto-sync-minutes");
    expect(found("focus")).toContain("auto-sync-focus");
  });

  it("lists every command in the Shortcuts section, with or without a shortcut", () => {
    const items = page.sections().find((s) => s.id === "shortcuts")!.items;
    expect(items.map((i) => [i.label, i.kind === "shortcut" ? i.commandId : null])).toEqual([
      ["Close terminal tab", "close-terminal-tab"],
      ["Do a", "a"],
      ["Do x", "x"],
      ["New terminal tab", "new-terminal-tab"],
      ["Open Claude in the vault", "open-claude-in-vault"],
      ["Open Copilot in the vault", "open-copilot-in-vault"],
      ["Toggle terminal", "toggle-terminal"],
    ]);
  });

  it("offers the four log levels in General and changes the setting", () => {
    const item = TestBed.inject(SettingsRegistry)
      .shown()
      .flatMap((s) => s.items)
      .find((i) => i.id === "log-level")!;
    if (item.kind !== "select") throw new Error("select expected");
    expect(item.options.map((o) => o.value)).toEqual(["error", "warn", "info", "debug"]);
    expect(item.get()).toBe("info");
    item.set("debug");
    expect(settings.logLevel()).toBe("debug");
    item.set("trace");
    expect(settings.logLevel()).toBe("info");
  });

  it("names the log folder in General once it is known", async () => {
    const find = () =>
      TestBed.inject(SettingsRegistry)
        .shown()
        .flatMap((s) => s.items)
        .find((i) => i.id === "log-folder");
    expect(find()).toBeUndefined();
    const logs = TestBed.inject(LogActionsService);
    logs.folder.set("/home/me/.local/share/dev.nixe.app/logs");
    const item = find()!;
    if (item.kind !== "readonly") throw new Error("readonly expected");
    expect(item.value()).toBe("/home/me/.local/share/dev.nixe.app/logs");
  });

  it("has the terminal off by default and asks before it turns on", async () => {
    ask.mockResolvedValue(true);
    const item = TestBed.inject(SettingsRegistry)
      .shown()
      .flatMap((s) => s.items)
      .find((i) => i.id === "terminal-enabled")!;
    if (item.kind !== "toggle") throw new Error("toggle expected");
    expect(item.get()).toBe(false);
    item.set(true);
    await vi.waitFor(() => expect(settings.terminalEnabled()).toBe(true));
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it("keeps the terminal off when the confirmation is declined", async () => {
    ask.mockResolvedValue(false);
    const item = TestBed.inject(SettingsRegistry)
      .shown()
      .flatMap((s) => s.items)
      .find((i) => i.id === "terminal-enabled")!;
    if (item.kind !== "toggle") throw new Error("toggle expected");
    item.set(true);
    await vi.waitFor(() => expect(ask).toHaveBeenCalledTimes(1));
    await Promise.resolve();
    expect(settings.terminalEnabled()).toBe(false);
  });

  it("has no terminal section where there is no terminal (iOS)", () => {
    const sections = builtinSections({
      settings,
      obsidian: () => null,
      commands: () => [],
      version: () => "",
    });
    expect(sections.map((s) => s.id)).not.toContain("terminal");
    expect(
      builtinSections({
        settings,
        obsidian: () => null,
        commands: () => [],
        version: () => "",
        terminal: { setEnabled: async () => true },
      }).map((s) => s.id),
    ).toContain("terminal");
  });

  it("parses comma separated lists", () => {
    expect(parseList(" a, b ,,c ")).toEqual(["a", "b", "c"]);
    expect(parseList("")).toEqual([]);
    expect(typeof builtinSections).toBe("function");
  });
});

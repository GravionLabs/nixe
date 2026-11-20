// @vitest-environment jsdom
import "@angular/compiler";
import { TestBed } from "@angular/core/testing";
import { BrowserTestingModule, platformBrowserTesting } from "@angular/platform-browser/testing";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { backend } from "../file/backend";
import { SettingsService } from "../settings/settings.service";
import { CssFile } from "./appearance-core";
import { AppearanceService } from "./appearance.service";

const file = (name: string, css: string, modified = 1): CssFile => ({ name, css, modified });
const text = (id: string) => document.getElementById(id)?.textContent ?? null;

describe("AppearanceService", () => {
  let themes: CssFile[];
  let snippets: CssFile[];
  let service: AppearanceService;
  let settings: SettingsService;

  beforeAll(() => TestBed.initTestEnvironment(BrowserTestingModule, platformBrowserTesting()));

  beforeEach(() => {
    themes = [file("sepia", ":root{--x:1}")];
    snippets = [file("wide", "a{}"), file("round", "b{}")];
    vi.spyOn(backend, "readAppearance").mockImplementation(async (kind) =>
      kind === "themes" ? themes : snippets,
    );
    vi.spyOn(backend, "appearanceDir").mockResolvedValue("/cfg");
    vi.spyOn(backend, "writeAppSettings").mockResolvedValue(undefined);
    localStorage.clear();
    document.head.innerHTML = "";
    window.matchMedia = (() => ({
      matches: false,
      addEventListener: () => undefined,
    })) as unknown as typeof window.matchMedia;
    TestBed.resetTestingModule();
    service = TestBed.inject(AppearanceService);
    settings = TestBed.inject(SettingsService);
  });

  afterEach(() => {
    service.stop();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("lists the themes and snippets and the folder", async () => {
    await service.start();
    expect(service.themes().map((t) => t.name)).toEqual(["sepia"]);
    expect(service.snippets().map((t) => t.name)).toEqual(["wide", "round"]);
    expect(service.folder()).toBe("/cfg");
  });

  it("applies the chosen theme live and removes it for none", async () => {
    await service.start();
    TestBed.tick();
    expect(text("nixe-theme")).toBeNull();
    settings.appearanceTheme.set("sepia");
    TestBed.tick();
    expect(text("nixe-theme")).toBe(":root{--x:1}");
    settings.appearanceTheme.set("");
    TestBed.tick();
    expect(document.getElementById("nixe-theme")).toBeNull();
  });

  it("applies only the enabled snippets and switches them one by one", async () => {
    await service.start();
    settings.snippets.set(["round"]);
    TestBed.tick();
    expect(text("nixe-snippets")).toBe("b{}");
    settings.snippets.set(["wide", "round"]);
    TestBed.tick();
    expect(text("nixe-snippets")).toBe("a{}\nb{}");
    settings.snippets.set([]);
    TestBed.tick();
    expect(document.getElementById("nixe-snippets")).toBeNull();
  });

  it("applies the accent color and the fonts", async () => {
    await service.start();
    settings.accentColor.set("#112233");
    settings.fontText.set("Inter");
    TestBed.tick();
    expect(text("nixe-overrides")).toContain("--nixe-accent:#112233");
    expect(text("nixe-overrides")).toContain("--nixe-font-text:Inter");
  });

  it("reloads a snippet when its file changes", async () => {
    vi.useFakeTimers();
    await service.start();
    settings.snippets.set(["wide"]);
    TestBed.tick();
    expect(text("nixe-snippets")).toBe("a{}");
    snippets = [file("wide", "a{color:red}", 2), file("round", "b{}")];
    await vi.advanceTimersByTimeAsync(2100);
    TestBed.tick();
    expect(text("nixe-snippets")).toBe("a{color:red}");
  });

  it("reports an unreadable folder", async () => {
    vi.spyOn(backend, "readAppearance").mockRejectedValue("denied");
    await service.refresh();
    expect(service.error()).toBe("denied");
  });
});

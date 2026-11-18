// @vitest-environment jsdom
import "@angular/compiler";
import { TestBed } from "@angular/core/testing";
import { BrowserTestingModule, platformBrowserTesting } from "@angular/platform-browser/testing";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { backend } from "../file/backend";
import { LEGACY_STORAGE_KEY } from "./settings-core";
import { SettingsService } from "./settings.service";

function stubMatchMedia(): void {
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: () => undefined }));
  window.matchMedia = (() => ({ matches: false, addEventListener: () => undefined })) as unknown as typeof window.matchMedia;
}

describe("SettingsService storage", () => {
  const read = vi.spyOn(backend, "readAppSettings");
  const write = vi.spyOn(backend, "writeAppSettings");

  beforeAll(() => TestBed.initTestEnvironment(BrowserTestingModule, platformBrowserTesting()));

  beforeEach(() => {
    read.mockReset();
    write.mockReset().mockResolvedValue(undefined);
    localStorage.clear();
    stubMatchMedia();
    TestBed.resetTestingModule();
  });

  it("applies the settings file at load, without a restart", async () => {
    read.mockResolvedValue(JSON.stringify({ theme: "dark", zoom: 130 }));
    const settings = TestBed.inject(SettingsService);
    await settings.load();
    expect(settings.themeMode()).toBe("dark");
    expect(settings.zoom()).toBe(130);
    expect(settings.dark()).toBe(true);
  });

  it("migrates the localStorage entry into the file on the first start", async () => {
    localStorage.setItem(LEGACY_STORAGE_KEY, JSON.stringify({ theme: "light", lastFolder: "/v", recentVaults: ["/v"] }));
    read.mockResolvedValue(null);
    const settings = TestBed.inject(SettingsService);
    await settings.load();
    await settings.flush();
    expect(settings.lastFolder()).toBe("/v");
    expect(write).toHaveBeenCalledTimes(1);
    expect(JSON.parse(write.mock.calls[0][0])).toMatchObject({ theme: "light", lastFolder: "/v", recentVaults: ["/v"] });
    expect(localStorage.getItem(LEGACY_STORAGE_KEY)).toBeNull();
  });

  it("writes a change to the file", async () => {
    read.mockResolvedValue(JSON.stringify({}));
    const settings = TestBed.inject(SettingsService);
    await settings.load();
    write.mockClear();
    settings.math.set(false);
    TestBed.tick();
    await settings.flush();
    expect(JSON.parse(write.mock.calls.at(-1)![0]).math).toBe(false);
  });

  it("keeps using localStorage and never writes the file when it cannot be read", async () => {
    read.mockRejectedValue(new Error("denied"));
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const settings = TestBed.inject(SettingsService);
    await settings.load();
    settings.zoom.set(150);
    TestBed.tick();
    await settings.flush();
    expect(write).not.toHaveBeenCalled();
    expect(JSON.parse(localStorage.getItem(LEGACY_STORAGE_KEY)!).zoom).toBe(150);
  });

  it("leaves a damaged settings file untouched", async () => {
    read.mockResolvedValue("{broken");
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const settings = TestBed.inject(SettingsService);
    await settings.load();
    settings.zoom.set(140);
    TestBed.tick();
    await settings.flush();
    expect(write).not.toHaveBeenCalled();
  });
});

describe("SettingsService theme", () => {
  beforeAll(() => {
    try {
      TestBed.initTestEnvironment(BrowserTestingModule, platformBrowserTesting());
    } catch {
      // already initialised by an earlier suite in this file
    }
  });

  beforeEach(() => {
    localStorage.clear();
    stubMatchMedia();
    document.documentElement.className = "";
    TestBed.resetTestingModule();
  });

  it("switches the class .app-dark of HxTheme with the stored setting and sets no data-theme", () => {
    const settings = TestBed.inject(SettingsService);
    settings.themeMode.set("dark");
    TestBed.tick();
    expect(document.documentElement.classList.contains("app-dark")).toBe(true);
    expect(document.documentElement.dataset["theme"]).toBeUndefined();

    settings.themeMode.set("light");
    TestBed.tick();
    expect(document.documentElement.classList.contains("app-dark")).toBe(false);
  });

  it("follows the system in the mode system", () => {
    vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener: () => undefined }));
    window.matchMedia = (() => ({ matches: true, addEventListener: () => undefined })) as unknown as typeof window.matchMedia;
    const settings = TestBed.inject(SettingsService);
    TestBed.tick();
    expect(settings.themeMode()).toBe("system");
    expect(document.documentElement.classList.contains("app-dark")).toBe(true);
  });
});

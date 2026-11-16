// @vitest-environment jsdom
import "@angular/compiler";
import { TestBed } from "@angular/core/testing";
import { BrowserTestingModule, platformBrowserTesting } from "@angular/platform-browser/testing";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { backend } from "../file/backend";
import { LEGACY_STORAGE_KEY, serializeSettings } from "../settings/settings-core";
import { SettingsService } from "../settings/settings.service";
import { CommandRegistry, KeyInput } from "./command-registry";
import { ShortcutService } from "./shortcut.service";

const key = (k: string, mods: Partial<KeyInput> = {}): KeyInput & { code: string } => ({
  key: k,
  code: `Key${k.toUpperCase()}`,
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  ...mods,
});

describe("ShortcutService", () => {
  const menu = vi.spyOn(backend, "setMenuShortcuts");
  const write = vi.spyOn(backend, "writeAppSettings");
  let registry: CommandRegistry;
  let settings: SettingsService;
  let shortcuts: ShortcutService;
  const runs: string[] = [];

  const flush = async () => {
    TestBed.tick();
    await Promise.resolve();
    await Promise.resolve();
  };

  beforeAll(() => TestBed.initTestEnvironment(BrowserTestingModule, platformBrowserTesting()));

  beforeEach(async () => {
    menu.mockReset().mockResolvedValue(0);
    write.mockReset().mockResolvedValue(undefined);
    vi.spyOn(backend, "readAppSettings").mockResolvedValue(null);
    runs.length = 0;
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)");
    localStorage.clear();
    window.matchMedia = (() => ({ matches: false, addEventListener: () => undefined })) as unknown as typeof window.matchMedia;
    TestBed.resetTestingModule();
    registry = TestBed.inject(CommandRegistry);
    settings = TestBed.inject(SettingsService);
    registry.register({ id: "one", title: "One", shortcut: "Mod+1", keys: ["Mod+1"], run: () => runs.push("one") });
    registry.register({ id: "two", title: "Two", shortcut: "Mod+2", run: () => runs.push("two") });
    registry.register({ id: "free", title: "Free", run: () => runs.push("free") });
    shortcuts = TestBed.inject(ShortcutService);
    await flush();
  });

  const command = (id: string) => registry.get(id)!;

  it("leaves the menu alone while the user changed nothing", () => {
    expect(menu).not.toHaveBeenCalled();
    expect(shortcuts.display("one")).not.toBe("");
  });

  it("changes a shortcut: the key handling and the menu follow, and the file stores it", async () => {
    await settings.load();
    shortcuts.assign(command("one"), "Mod+Shift+K");
    await flush();
    expect(settings.shortcuts()).toEqual({ one: "Mod+Shift+K" });
    expect(registry.findByKey(key("k", { metaKey: true, shiftKey: true }))?.id).toBe("one");
    expect(registry.findByKey(key("1", { metaKey: true }))).toBeUndefined();
    expect(registry.shortcutOf(command("one"))).toBe("Mod+Shift+K");
    expect(menu).toHaveBeenLastCalledWith({ one: "CmdOrCtrl+Shift+K" });
    await settings.flush();
    expect(JSON.parse(write.mock.calls.at(-1)![0]).shortcuts).toEqual({ one: "Mod+Shift+K" });
    expect(localStorage.getItem(LEGACY_STORAGE_KEY)).toBeNull();
  });

  it("gives a command without a shortcut one that its key handler runs", async () => {
    shortcuts.assign(command("free"), "Mod+Alt+F");
    await flush();
    expect(registry.findByKey(key("f", { metaKey: true, altKey: true }))?.id).toBe("free");
  });

  it("removes a shortcut and resets it to the default", async () => {
    shortcuts.assign(command("one"), "");
    await flush();
    expect(shortcuts.display("one")).toBe("");
    expect(shortcuts.isDefault(command("one"))).toBe(false);
    expect(registry.findByKey(key("1", { metaKey: true }))).toBeUndefined();
    expect(menu).toHaveBeenLastCalledWith({ one: null });

    shortcuts.reset(command("one"));
    await flush();
    expect(shortcuts.isDefault(command("one"))).toBe(true);
    expect(settings.shortcuts()).toEqual({});
    expect(registry.findByKey(key("1", { metaKey: true }))?.id).toBe("one");
    expect(menu).toHaveBeenLastCalledWith({ one: "CmdOrCtrl+1" });
  });

  it("stores no override for the default shortcut", () => {
    shortcuts.assign(command("one"), "Mod+Shift+K");
    shortcuts.assign(command("one"), "mod+1");
    expect(settings.shortcuts()).toEqual({});
  });

  it("names the conflicts and takes the shortcut from the other command when saved", async () => {
    expect(shortcuts.conflicts(command("one"), "Mod+2").map((c) => c.id)).toEqual(["two"]);
    expect(shortcuts.conflicts(command("one"), "Mod+9")).toEqual([]);
    shortcuts.assign(command("one"), "Mod+2");
    await flush();
    expect(settings.shortcuts()).toEqual({ one: "Mod+2", two: "" });
    expect(shortcuts.display("two")).toBe("");
  });

  it("records a key press, shows its conflicts first and saves on request", async () => {
    shortcuts.startRecording("one");
    expect(shortcuts.recording()).toBe(true);
    shortcuts.capture(key("2", { metaKey: true, code: "Digit2" }));
    expect(shortcuts.recording()).toBe(false);
    expect(shortcuts.pending()).toMatchObject({ id: "one", conflicts: ["Two"] });
    expect(settings.shortcuts()).toEqual({});
    shortcuts.savePending();
    expect(shortcuts.pending()).toBeNull();
    expect(settings.shortcuts()).toEqual({ one: "Mod+2", two: "" });
  });

  it("ignores a lone modifier, and Escape cancels", () => {
    shortcuts.startRecording("one");
    shortcuts.capture({ ...key("Shift"), shiftKey: true });
    expect(shortcuts.recording()).toBe(true);
    expect(shortcuts.pending()).toBeNull();
    shortcuts.capture(key("Escape"));
    expect(shortcuts.recording()).toBe(false);
    expect(shortcuts.pending()).toBeNull();
    expect(settings.shortcuts()).toEqual({});
  });

  it("switches the menu accelerators off while recording and restores them after", async () => {
    shortcuts.startRecording("one");
    await flush();
    expect(menu).toHaveBeenLastCalledWith({ one: null, two: null, free: null });
    shortcuts.cancel();
    await flush();
    expect(menu).toHaveBeenLastCalledWith({ one: "CmdOrCtrl+1", two: "CmdOrCtrl+2", free: null });
  });

  it("applies the shortcuts of the settings file at start", async () => {
    vi.spyOn(backend, "readAppSettings").mockResolvedValue(serializeSettings({ ...settings["snapshot"](), shortcuts: { two: "Mod+Alt+T" } }));
    await settings.load();
    await flush();
    expect(registry.shortcutOf(command("two"))).toBe("Mod+Alt+T");
    expect(menu).toHaveBeenLastCalledWith({ two: "CmdOrCtrl+Alt+T" });
  });
});

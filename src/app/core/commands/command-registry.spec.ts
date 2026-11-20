// @vitest-environment jsdom
import "@angular/compiler";
import { TestBed } from "@angular/core/testing";
import { BrowserTestingModule, platformBrowserTesting } from "@angular/platform-browser/testing";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { KeyInput } from "./command-registry";
import { CommandRegistry, formatShortcut, matchesBinding, shortcutKeys } from "./command-registry";

const key = (k: string, mods: Partial<KeyInput> = {}): KeyInput => ({
  key: k,
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  ...mods,
});

beforeAll(() => TestBed.initTestEnvironment(BrowserTestingModule, platformBrowserTesting()));

describe("matchesBinding / formatShortcut", () => {
  it("matches Mod with meta or ctrl, exactly", () => {
    expect(matchesBinding(key("p", { metaKey: true }), "Mod+P")).toBe(true);
    expect(matchesBinding(key("P", { ctrlKey: true }), "Mod+P")).toBe(true);
    expect(matchesBinding(key("p"), "Mod+P")).toBe(false);
    expect(matchesBinding(key("p", { metaKey: true, shiftKey: true }), "Mod+P")).toBe(false);
    expect(matchesBinding(key("ArrowLeft", { altKey: true }), "Alt+ArrowLeft")).toBe(true);
  });

  it("matches Ctrl as the control key only", () => {
    expect(matchesBinding(key("Tab", { ctrlKey: true }), "Ctrl+Tab")).toBe(true);
    expect(matchesBinding(key("Tab", { metaKey: true }), "Ctrl+Tab")).toBe(false);
    expect(matchesBinding(key("Tab", { ctrlKey: true, shiftKey: true }), "Ctrl+Tab")).toBe(false);
    expect(matchesBinding(key("Tab", { ctrlKey: true, shiftKey: true }), "Ctrl+Shift+Tab")).toBe(
      true,
    );
    expect(formatShortcut("Ctrl+Tab", true)).toBe("⌃Tab");
    expect(formatShortcut("Ctrl+Tab", false)).toBe("Ctrl+Tab");
  });

  it("splits a shortcut into key caps per platform", () => {
    expect(shortcutKeys("Mod+Shift+F", true)).toEqual(["⌘", "⇧", "F"]);
    expect(shortcutKeys("Mod+Shift+F", false)).toEqual(["Ctrl", "Shift", "F"]);
    expect(shortcutKeys("", false)).toEqual([]);
  });

  it("formats per platform", () => {
    expect(formatShortcut("Mod+Shift+F", true)).toBe("⌘⇧F");
    expect(formatShortcut("Mod+Shift+F", false)).toBe("Ctrl+Shift+F");
  });
});

describe("CommandRegistry", () => {
  let registry: CommandRegistry;

  beforeEach(() => {
    TestBed.resetTestingModule();
    registry = TestBed.inject(CommandRegistry);
  });

  it("runs a registered command by id", () => {
    const run = vi.fn();
    registry.register({ id: "a", title: "A", run });
    expect(registry.execute("a")).toBe(true);
    expect(run).toHaveBeenCalledOnce();
  });

  it("ignores unknown ids", () => {
    expect(registry.execute("nope")).toBe(false);
  });

  it("evaluates when on every call", () => {
    let on = false;
    const run = vi.fn();
    registry.register({ id: "a", title: "A", when: () => on, run });
    expect(registry.execute("a")).toBe(false);
    expect(registry.available()).toEqual([]);
    expect(run).not.toHaveBeenCalled();
    on = true;
    expect(registry.execute("a")).toBe(true);
    expect(registry.available().map((c) => c.id)).toEqual(["a"]);
  });

  it("replaces by id and unregisters only its own registration", () => {
    const first = registry.register({ id: "a", title: "One", run: () => {} });
    registry.register({ id: "a", title: "Two", run: () => {} });
    first();
    expect(registry.get("a")?.title).toBe("Two");
  });

  it("finds a command by key binding", () => {
    registry.register({ id: "p", title: "P", keys: ["Mod+P"], run: () => {} });
    registry.register({ id: "q", title: "Q", shortcut: "Mod+Q", run: () => {} });
    expect(registry.findByKey(key("p", { metaKey: true }))?.id).toBe("p");
    expect(registry.findByKey(key("q", { metaKey: true }))).toBeUndefined();
  });
});

describe("matchesBinding with the physical key", () => {
  it("matches ⌥ letters on macOS, where key is another character", () => {
    const event = { ...key("å", { metaKey: true, altKey: true }), code: "KeyA" };
    expect(matchesBinding(event, "Mod+Alt+A")).toBe(true);
    expect(matchesBinding({ ...event, code: "KeyB" }, "Mod+Alt+A")).toBe(false);
  });

  it("matches Plus and Space by name", () => {
    expect(matchesBinding(key("+", { ctrlKey: true, shiftKey: true }), "Mod+Shift+Plus")).toBe(
      true,
    );
    expect(matchesBinding(key(" ", { ctrlKey: true }), "Mod+Space")).toBe(true);
    expect(formatShortcut("Mod+Shift+Plus", true)).toBe("⌘⇧+");
    expect(formatShortcut("Mod+Shift+Plus", false)).toBe("Ctrl+Shift++");
  });
});

describe("matchesBinding on other layouts", () => {
  it("does not match a letter by position when the key shows another letter", () => {
    expect(matchesBinding({ ...key("w", { ctrlKey: true }), code: "KeyZ" }, "Mod+Z")).toBe(false);
    expect(matchesBinding({ ...key("z", { ctrlKey: true }), code: "KeyW" }, "Mod+Z")).toBe(true);
  });
});

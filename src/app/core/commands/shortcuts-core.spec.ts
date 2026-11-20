import { describe, expect, it } from "vitest";

import { matchesBinding } from "./command-registry";
import type { RecordedKey } from "./shortcuts-core";
import {
  bindingFromEvent,
  canonicalBinding,
  effectiveBindings,
  findConflicts,
  platformOf,
  sanitizeShortcuts,
  toAccelerator,
} from "./shortcuts-core";

const press = (key: string, code: string, mods: Partial<RecordedKey> = {}): RecordedKey => ({
  key,
  code,
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  ...mods,
});

describe("platformOf", () => {
  it("tells the platforms apart", () => {
    expect(platformOf("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)")).toBe("mac");
    expect(platformOf("Mozilla/5.0 (Windows NT 10.0; Win64; x64)")).toBe("windows");
    expect(platformOf("Mozilla/5.0 (X11; Linux x86_64)")).toBe("linux");
  });
});

describe("bindingFromEvent", () => {
  it("records ⌘ as Mod and ⌃ as Ctrl on macOS", () => {
    expect(bindingFromEvent(press("k", "KeyK", { metaKey: true, shiftKey: true }), "mac")).toBe(
      "Mod+Shift+K",
    );
    expect(bindingFromEvent(press("Tab", "Tab", { ctrlKey: true }), "mac")).toBe("Ctrl+Tab");
    expect(
      bindingFromEvent(press("k", "KeyK", { metaKey: true, ctrlKey: true }), "mac"),
    ).toBeNull();
  });

  it.each(["windows", "linux"] as const)(
    "records Ctrl as Mod on %s and refuses the Super key",
    (platform) => {
      expect(bindingFromEvent(press("k", "KeyK", { ctrlKey: true, altKey: true }), platform)).toBe(
        "Mod+Alt+K",
      );
      expect(
        bindingFromEvent(press("Tab", "Tab", { ctrlKey: true, shiftKey: true }), platform),
      ).toBe("Mod+Shift+Tab");
      expect(bindingFromEvent(press("k", "KeyK", { metaKey: true }), platform)).toBeNull();
    },
  );

  it("reads letters from the physical key, so ⌥ letters work on macOS", () => {
    expect(bindingFromEvent(press("å", "KeyA", { metaKey: true, altKey: true }), "mac")).toBe(
      "Mod+Alt+A",
    );
    expect(bindingFromEvent(press("!", "Digit1", { ctrlKey: true, shiftKey: true }), "linux")).toBe(
      "Mod+Shift+1",
    );
  });

  it("names the keys that clash with the separator or are blank", () => {
    expect(
      bindingFromEvent(press("+", "Equal", { ctrlKey: true, shiftKey: true }), "windows"),
    ).toBe("Mod+Shift+Plus");
    expect(bindingFromEvent(press(" ", "Space", { ctrlKey: true }), "linux")).toBe("Mod+Space");
    expect(bindingFromEvent(press("=", "Equal", { metaKey: true }), "mac")).toBe("Mod+=");
    expect(bindingFromEvent(press("ArrowLeft", "ArrowLeft", { altKey: true }), "mac")).toBe(
      "Alt+ArrowLeft",
    );
  });

  it("records punctuation by its physical key, so ⇧ and ⌥ do not change it", () => {
    expect(bindingFromEvent(press("<", "Comma", { ctrlKey: true, shiftKey: true }), "linux")).toBe(
      "Mod+Shift+,",
    );
    expect(bindingFromEvent(press("≤", "Comma", { metaKey: true, altKey: true }), "mac")).toBe(
      "Mod+Alt+,",
    );
    const event = press("<", "Comma", { ctrlKey: true, shiftKey: true });
    expect(matchesBinding(event, "Mod+Shift+,")).toBe(true);
  });

  it("records the letter on the key, not its position, on other layouts", () => {
    expect(bindingFromEvent(press("b", "KeyN", { ctrlKey: true }), "windows")).toBe("Mod+B");
  });

  it("refuses the shortcuts of the native menu items", () => {
    expect(bindingFromEvent(press("c", "KeyC", { metaKey: true }), "mac")).toBeNull();
    expect(bindingFromEvent(press("q", "KeyQ", { metaKey: true }), "mac")).toBeNull();
    expect(bindingFromEvent(press("v", "KeyV", { ctrlKey: true }), "linux")).toBeNull();
  });

  it("refuses a modifier alone and a key without modifier, except function keys", () => {
    expect(bindingFromEvent(press("Shift", "ShiftLeft", { shiftKey: true }), "mac")).toBeNull();
    expect(
      bindingFromEvent(press("Control", "ControlLeft", { ctrlKey: true }), "windows"),
    ).toBeNull();
    expect(bindingFromEvent(press("a", "KeyA"), "linux")).toBeNull();
    expect(bindingFromEvent(press("F5", "F5"), "linux")).toBe("F5");
    expect(bindingFromEvent(press("F5", "F5", { shiftKey: true }), "windows")).toBe("Shift+F5");
  });

  it("records bindings that the key handler matches again", () => {
    const event = press("å", "KeyA", { metaKey: true, altKey: true });
    expect(matchesBinding(event, bindingFromEvent(event, "mac")!)).toBe(true);
    const plus = press("+", "Equal", { ctrlKey: true, shiftKey: true });
    expect(matchesBinding(plus, bindingFromEvent(plus, "linux")!)).toBe(true);
    const space = press(" ", "Space", { ctrlKey: true });
    expect(matchesBinding(space, bindingFromEvent(space, "windows")!)).toBe(true);
  });
});

describe("canonicalBinding", () => {
  it("ignores case and the order of the modifiers", () => {
    expect(canonicalBinding("shift+mod+f", "mac")).toBe(canonicalBinding("Mod+Shift+F", "mac"));
  });

  it("treats Ctrl as Mod where Ctrl is the command key", () => {
    expect(canonicalBinding("Ctrl+Tab", "windows")).toBe(canonicalBinding("Mod+Tab", "windows"));
    expect(canonicalBinding("Ctrl+Tab", "linux")).toBe(canonicalBinding("Mod+Tab", "linux"));
    expect(canonicalBinding("Ctrl+Tab", "mac")).not.toBe(canonicalBinding("Mod+Tab", "mac"));
  });
});

describe("findConflicts", () => {
  const bindings = { a: "Mod+K", b: "Mod+Shift+K", c: "", d: "Ctrl+Tab" };

  it("finds the other commands with the same binding", () => {
    expect(findConflicts(bindings, "b", "Mod+K", "mac")).toEqual(["a"]);
    expect(findConflicts(bindings, "a", "shift+mod+k", "mac")).toEqual(["b"]);
  });

  it("does not report the command itself or an empty binding", () => {
    expect(findConflicts(bindings, "a", "Mod+K", "mac")).toEqual([]);
    expect(findConflicts(bindings, "a", "", "mac")).toEqual([]);
  });

  it("compares Ctrl and Mod per platform", () => {
    expect(findConflicts(bindings, "a", "Mod+Tab", "windows")).toEqual(["d"]);
    expect(findConflicts(bindings, "a", "Mod+Tab", "mac")).toEqual([]);
  });
});

describe("effectiveBindings", () => {
  it("lets an override, also an empty one, replace the default", () => {
    expect(
      effectiveBindings({ a: "Mod+A", b: "Mod+B", c: "" }, { a: "Mod+X", b: "", z: "Mod+Z" }),
    ).toEqual({
      a: "Mod+X",
      b: "",
      c: "",
    });
  });
});

describe("toAccelerator", () => {
  it("writes the menu accelerator", () => {
    expect(toAccelerator("Mod+Shift+F")).toBe("CmdOrCtrl+Shift+F");
    expect(toAccelerator("Alt+ArrowLeft")).toBe("Alt+Left");
    expect(toAccelerator("Ctrl+Tab")).toBe("Ctrl+Tab");
    expect(toAccelerator("Mod+,")).toBe("CmdOrCtrl+,");
  });
});

describe("sanitizeShortcuts", () => {
  it("keeps string values only", () => {
    expect(sanitizeShortcuts({ a: "Mod+K", b: 3, c: null, d: "" })).toEqual({ a: "Mod+K", d: "" });
    expect(sanitizeShortcuts(null)).toEqual({});
    expect(sanitizeShortcuts(["Mod+K"])).toEqual({});
    expect(sanitizeShortcuts("x")).toEqual({});
  });
});

import { describe, expect, it } from "vitest";

import { PreviewCache, placePopover, previewAllowed, sanitizeMode, targetOf } from "./preview-core";

describe("previewAllowed", () => {
  it("needs the modifier in modifier mode and not in always mode", () => {
    expect(previewAllowed("modifier", false)).toBe(false);
    expect(previewAllowed("modifier", true)).toBe(true);
    expect(previewAllowed("always", false)).toBe(true);
  });

  it("falls back to modifier for stored junk", () => {
    expect(sanitizeMode("always")).toBe("always");
    expect(sanitizeMode("x")).toBe("modifier");
    expect(sanitizeMode(undefined)).toBe("modifier");
  });
});

describe("targetOf", () => {
  it("drops the alias", () => {
    expect(targetOf("Note#Head|Shown")).toBe("Note#Head");
    expect(targetOf(" Note ")).toBe("Note");
  });
});

describe("placePopover", () => {
  const size = { width: 400, height: 300 };
  const viewport = { width: 1000, height: 800 };

  it("opens below the anchor", () => {
    expect(placePopover({ left: 100, top: 100, bottom: 120 }, size, viewport)).toEqual({ left: 100, top: 124, bottom: null });
  });

  it("flips above near the bottom", () => {
    expect(placePopover({ left: 100, top: 700, bottom: 720 }, size, viewport)).toEqual({ left: 100, top: null, bottom: 104 });
  });

  it("keeps the popover inside the window horizontally", () => {
    expect(placePopover({ left: 950, top: 100, bottom: 120 }, size, viewport).left).toBe(592);
    expect(placePopover({ left: -20, top: 100, bottom: 120 }, size, viewport).left).toBe(8);
  });
});

describe("PreviewCache", () => {
  const stamp = {};

  it("returns the html while the note and stamp are unchanged", () => {
    const cache = new PreviewCache();
    cache.set("a", "text", stamp, "<p>x</p>");
    expect(cache.get("a", "text", stamp)).toBe("<p>x</p>");
  });

  it("drops the entry when the note changed", () => {
    const cache = new PreviewCache();
    cache.set("a", "text", stamp, "<p>x</p>");
    expect(cache.get("a", "text 2", stamp)).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it("drops the entry when the vault files changed", () => {
    const cache = new PreviewCache();
    cache.set("a", "text", stamp, "<p>x</p>");
    expect(cache.get("a", "text", {})).toBeUndefined();
  });

  it("keeps at most `max` entries, dropping the least recently used", () => {
    const cache = new PreviewCache(2);
    cache.set("a", "1", stamp, "A");
    cache.set("b", "2", stamp, "B");
    cache.get("a", "1", stamp);
    cache.set("c", "3", stamp, "C");
    expect(cache.get("b", "2", stamp)).toBeUndefined();
    expect(cache.get("a", "1", stamp)).toBe("A");
    expect(cache.get("c", "3", stamp)).toBe("C");
  });
});

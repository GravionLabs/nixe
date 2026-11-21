import { beforeEach, describe, expect, it, vi } from "vitest";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

import { computed, signal } from "@angular/core";

import { EditorService } from "./editor.service";

function make(path: string | null) {
  const settings = { defaultView: signal<"live" | "source" | "reading">("live") };
  const doc = { path: signal(path), pendingLine: signal<number | null>(null) };
  const service = Object.create(EditorService.prototype) as EditorService;
  const reading = signal(false);
  const source = signal(false);
  Object.assign(service, {
    doc,
    editing: signal(false),
    reading,
    source,
    mode: computed(() => (reading() ? "reading" : source() ? "source" : "live")),
    modeChosen: false,
    injector: { get: () => settings },
    startLine: signal<number | null>(null),
    handle: null,
  });
  return { service, doc, settings };
}

describe("EditorService", () => {
  beforeEach(() => invoke.mockReset().mockResolvedValue(true));

  it("opens at the line the viewer shows", async () => {
    const { service } = make("/v/a.md");
    await service.toggle(12);
    expect(service.editing()).toBe(true);
    expect(service.startLine()).toBe(12);
  });

  it("does nothing without an open note", async () => {
    const { service } = make(null);
    await service.toggle(1);
    expect(service.editing()).toBe(false);
  });

  it("flushes and hands the editor line to the viewer when it closes", async () => {
    const { service, doc } = make("/v/a.md");
    await service.toggle(1);
    const flush = vi.fn().mockResolvedValue(undefined);
    service.handle = { topLine: () => 7, flush, blocked: () => false };
    await service.toggle(null);
    expect(flush).toHaveBeenCalled();
    expect(doc.pendingLine()).toBe(7);
    expect(service.editing()).toBe(false);
  });

  it("refuses a note that is not valid UTF-8", async () => {
    invoke.mockResolvedValue(false);
    const { service } = make("/v/a.md");
    await expect(service.toggle(1)).rejects.toThrow(/UTF-8/);
    expect(service.editing()).toBe(false);
  });

  it("stays open while an external change waits for a choice", async () => {
    const { service } = make("/v/a.md");
    await service.toggle(1);
    service.handle = { topLine: () => 1, flush: vi.fn(), blocked: () => true };
    await expect(service.toggle(null)).rejects.toThrow(/Reload or Keep mine/);
    expect(service.editing()).toBe(true);
  });

  it("Mod+E switches between live preview and source while the editor is open", async () => {
    const { service } = make("/v/a.md");
    await service.toggle(1);
    expect(service.mode()).toBe("live");
    await service.toggleMode(null);
    expect(service.mode()).toBe("source");
    await service.toggleMode(null);
    expect(service.mode()).toBe("live");
    expect(service.editing()).toBe(true);
  });

  it("Mod+E leaves the reading view for the editor in the mode used last", async () => {
    const { service } = make("/v/a.md");
    await service.setMode("source");
    await service.setMode("reading");
    expect(service.mode()).toBe("reading");
    await service.toggleMode(5);
    expect(service.editing()).toBe(true);
    expect(service.mode()).toBe("source");
    expect(service.startLine()).toBe(5);
  });

  it("sets every mode and keeps it per tab", async () => {
    const a = make("/v/a.md").service;
    const b = make("/v/b.md").service;
    await a.setMode("reading");
    expect(a.mode()).toBe("reading");
    expect(a.editing()).toBe(false);
    expect(b.mode()).toBe("live");
    await a.setMode("source", 3);
    expect(a.editing()).toBe(true);
    expect(a.mode()).toBe("source");
    await a.setMode("live");
    expect(a.mode()).toBe("live");
    expect(a.editing()).toBe(true);
    await a.setMode("reading");
    expect(a.editing()).toBe(false);
    expect(a.reading()).toBe(true);
  });

  it("toggles the reading view and returns to the mode before it", async () => {
    const { service } = make("/v/a.md");
    await service.setMode("source");
    await service.toggleReading(null);
    expect(service.mode()).toBe("reading");
    await service.toggleReading(null);
    expect(service.mode()).toBe("source");
    expect(service.editing()).toBe(true);
  });

  it("takes the default view once, when the first note opens", () => {
    const { service, settings } = make("/v/a.md");
    settings.defaultView.set("reading");
    service.applyDefaultMode();
    expect(service.mode()).toBe("reading");
    settings.defaultView.set("source");
    service.applyDefaultMode();
    expect(service.mode()).toBe("reading");
    const other = make("/v/b.md");
    other.settings.defaultView.set("source");
    other.service.applyDefaultMode();
    expect(other.service.mode()).toBe("source");
  });

  it("a split copies the mode and does not take the default", () => {
    const a = make("/v/a.md");
    const b = make("/v/a.md");
    a.service.reading.set(true);
    b.settings.defaultView.set("source");
    b.service.copyModeFrom(a.service);
    b.service.applyDefaultMode();
    expect(b.service.mode()).toBe("reading");
  });
});

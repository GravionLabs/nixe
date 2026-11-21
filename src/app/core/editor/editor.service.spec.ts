import { beforeEach, describe, expect, it, vi } from "vitest";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

import { signal } from "@angular/core";

import { EditorService } from "./editor.service";

function make(path: string | null) {
  const settings = { sourceMode: signal(false) };
  const doc = { path: signal(path), pendingLine: signal<number | null>(null) };
  const service = Object.create(EditorService.prototype) as EditorService;
  Object.assign(service, {
    doc,
    editing: signal(false),
    reading: signal(false),
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
    const { service, settings } = make("/v/a.md");
    await service.toggle(1);
    await service.toggleMode(null);
    expect(settings.sourceMode()).toBe(true);
    await service.toggleMode(null);
    expect(settings.sourceMode()).toBe(false);
    expect(service.editing()).toBe(true);
  });

  it("Mod+E leaves the reading view for the editor", async () => {
    const { service } = make("/v/a.md");
    await service.openReading();
    expect(service.editing()).toBe(false);
    await service.toggle(1);
    await service.openReading();
    expect(service.reading()).toBe(true);
    await service.toggleMode(5);
    expect(service.editing()).toBe(true);
    expect(service.reading()).toBe(false);
    expect(service.startLine()).toBe(5);
  });
});

import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

import { signal } from "@angular/core";

import { EditorService } from "./editor.service";

function make(path: string | null, vaultRoot: string | null) {
  const doc = { path: signal(path), pendingLine: signal<number | null>(null) };
  const workspace = { vaultRoot: signal(vaultRoot) };
  const service = Object.create(EditorService.prototype) as EditorService;
  Object.assign(service, {
    doc,
    workspace,
    editing: signal(false),
    startLine: signal<number | null>(null),
    handle: null,
  });
  return { service, doc };
}

describe("EditorService", () => {
  it("opens at the line the viewer shows", async () => {
    const { service } = make("/v/a.md", "/v");
    await service.toggle(12);
    expect(service.editing()).toBe(true);
    expect(service.startLine()).toBe(12);
  });

  it("does nothing without an open note", async () => {
    const { service } = make(null, null);
    await service.toggle(1);
    expect(service.editing()).toBe(false);
  });

  it("flushes and hands the editor line to the viewer when it closes", async () => {
    const { service, doc } = make("/v/a.md", "/v");
    await service.toggle(1);
    const flush = vi.fn().mockResolvedValue(undefined);
    service.handle = { topLine: () => 7, flush };
    await service.toggle(null);
    expect(flush).toHaveBeenCalled();
    expect(doc.pendingLine()).toBe(7);
    expect(service.editing()).toBe(false);
  });

  it("limits writes to the vault, or to the note's folder outside it", () => {
    const { service } = make("/v/a.md", "/v");
    expect(service.rootFor("/v/sub/a.md")).toBe("/v");
    expect(service.rootFor("/other/b.md")).toBe("/other");
    expect(service.rootFor("/vault2/b.md")).toBe("/vault2");
  });
});

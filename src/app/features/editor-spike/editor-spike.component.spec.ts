import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import { EditorSpikeComponent } from "./editor-spike.component";

describe("EditorSpikeComponent", () => {
  beforeEach(() => {
    invoke.mockReset();
    invoke.mockResolvedValue([]);
  });

  it("lists the notes on start", async () => {
    invoke.mockResolvedValue(["a.md"]);
    const c = new EditorSpikeComponent() as any;
    await c.refresh();
    expect(invoke).toHaveBeenCalledWith("notes_list");
    expect(c.names()).toEqual(["a.md"]);
  });

  it("reports a failing list instead of throwing", async () => {
    invoke.mockRejectedValue("denied");
    const c = new EditorSpikeComponent() as any;
    await c.refresh();
    expect(c.status()).toBe("list FAILED denied");
  });

  it("records ratings", () => {
    const c = new EditorSpikeComponent() as any;
    c.rate("undo", "annoying");
    expect(c.ratings()).toEqual({ undo: "annoying" });
  });

  it("does not save before a note is open", async () => {
    const c = new EditorSpikeComponent() as any;
    invoke.mockClear();
    await c.save();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("starts at 14px and resizes within bounds", () => {
    const c = new EditorSpikeComponent() as any;
    expect(c.fontSize()).toBe(14);
    c.resize(1);
    expect(c.fontSize()).toBe(15);
    for (let i = 0; i < 50; i++) c.resize(-1);
    expect(c.fontSize()).toBe(8);
  });
});

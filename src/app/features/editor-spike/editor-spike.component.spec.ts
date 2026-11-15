import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const pick = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: pick }));

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

  it("picks a scoped external file, reads it and writes it back", async () => {
    pick.mockResolvedValue("/icloud/n.md");
    invoke.mockImplementation(async (cmd: string) =>
      cmd === "spike_external_read" ? "hello" : undefined,
    );
    const c = new EditorSpikeComponent() as any;
    await c.openExternal();
    expect(pick).toHaveBeenCalledWith({
      multiple: false,
      fileAccessMode: "scoped",
    });
    expect(invoke).toHaveBeenCalledWith("spike_external_write", {
      path: "/icloud/n.md",
      content: "hello",
    });
    expect(c.status()).toBe(
      "external path: /icloud/n.md\nread OK, 5 chars\nwrite OK (same content written back)",
    );
  });

  it("reports the exact read and write errors", async () => {
    pick.mockResolvedValue("/icloud/n.md");
    const c = new EditorSpikeComponent() as any;
    await Promise.resolve();
    invoke.mockReset();
    invoke.mockRejectedValueOnce("Operation not permitted (os error 1)");
    await c.openExternal();
    expect(c.status()).toContain(
      "read FAILED: Operation not permitted (os error 1)",
    );
    invoke.mockReset();
    invoke.mockResolvedValueOnce("x").mockRejectedValueOnce("read-only");
    await c.openExternal();
    expect(c.status()).toContain("write FAILED: read-only");
  });

  it("does nothing when the picker is cancelled", async () => {
    pick.mockResolvedValue(null);
    const c = new EditorSpikeComponent() as any;
    invoke.mockClear();
    await c.openExternal();
    expect(c.status()).toBe("external: cancelled");
    expect(invoke).not.toHaveBeenCalled();
  });
});

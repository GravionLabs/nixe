import { beforeEach, describe, expect, it, vi } from "vitest";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import { backend, INDEX_EVENT } from "./backend";

describe("vault index commands", () => {
  beforeEach(() => invoke.mockReset());

  it("starts the scan for a vault root", async () => {
    invoke.mockResolvedValue(undefined);
    await backend.indexStart("/vault");
    expect(invoke).toHaveBeenCalledWith("index_start", { root: "/vault" });
  });

  it("reads the index status", async () => {
    const status = { state: "ready", done: 2, total: 2, notes: 2, error: null };
    invoke.mockResolvedValue(status);
    await expect(backend.indexStatus()).resolves.toEqual(status);
    expect(invoke).toHaveBeenCalledWith("index_status");
  });

  it("names the progress event like the Rust core", () => {
    expect(INDEX_EVENT).toBe("index-status");
  });
});

describe("write_text_file", () => {
  beforeEach(() => invoke.mockReset());

  it("passes path and content", async () => {
    invoke.mockResolvedValue(undefined);
    await backend.writeTextFile("/vault/a.md", "# a");
    expect(invoke).toHaveBeenCalledWith("write_text_file", {
      path: "/vault/a.md",
      content: "# a",
    });
  });
});

describe("read_epub", () => {
  beforeEach(() => invoke.mockReset());

  it("passes the roots and returns the bytes of the book", async () => {
    invoke.mockResolvedValue(new Uint8Array([1, 2, 3]).buffer);
    const bytes = await backend.readEpub("/r/a.epub", ["/r"]);
    expect(invoke).toHaveBeenCalledWith("read_epub", { path: "/r/a.epub", roots: ["/r"] });
    expect([...bytes]).toEqual([1, 2, 3]);
  });

  it("passes on the refusal of the backend", async () => {
    invoke.mockRejectedValue("outside the open roots and the vault: /x.epub");
    await expect(backend.readEpub("/x.epub", [])).rejects.toThrow("outside");
  });
});

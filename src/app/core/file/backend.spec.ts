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

  it("passes root, path and content", async () => {
    invoke.mockResolvedValue(undefined);
    await backend.writeTextFile("/vault", "/vault/a.md", "# a");
    expect(invoke).toHaveBeenCalledWith("write_text_file", {
      root: "/vault",
      path: "/vault/a.md",
      content: "# a",
    });
  });
});

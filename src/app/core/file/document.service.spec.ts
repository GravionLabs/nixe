import { beforeEach, describe, expect, it, vi } from "vitest";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

import { DocumentService } from "./document.service";

describe("DocumentService writing", () => {
  beforeEach(() => invoke.mockReset());

  async function opened(): Promise<DocumentService> {
    invoke.mockImplementation(async (cmd: string) => (cmd === "read_text_file" ? "old" : "/v"));
    const doc = new DocumentService();
    await doc.open("/v/a.md");
    invoke.mockReset();
    invoke.mockResolvedValue(undefined);
    return doc;
  }

  it("writes the note and keeps the saved text as content", async () => {
    const doc = await opened();
    await doc.write("/v/a.md", "new");
    expect(invoke).toHaveBeenCalledWith("write_text_file", { path: "/v/a.md", content: "new" });
    expect(doc.content()).toBe("new");
  });

  it("leaves the content alone when another note is open by now", async () => {
    const doc = await opened();
    await doc.write("/v/other.md", "other");
    expect(doc.content()).toBe("old");
  });

  it("does not touch the content when the write fails", async () => {
    const doc = await opened();
    invoke.mockRejectedValueOnce("denied");
    await expect(doc.write("/v/a.md", "new")).rejects.toBe("denied");
    expect(doc.content()).toBe("old");
  });

  it("hands external changes to the editor instead of the content", async () => {
    const doc = await opened();
    const hook = vi.fn();
    doc.editorHook = hook;
    invoke.mockResolvedValue("from disk");
    await doc.onExternalChange("/v/a.md");
    expect(hook).toHaveBeenCalledWith("/v/a.md", "from disk");
    expect(doc.content()).toBe("old");
  });

  it("applies external changes to the content without an editor", async () => {
    const doc = await opened();
    invoke.mockResolvedValue("from disk");
    await doc.onExternalChange("/v/a.md");
    expect(doc.content()).toBe("from disk");
  });

  describe("missing file", () => {
    function gone(exists: boolean): void {
      invoke.mockImplementation(async (cmd: string) => {
        if (cmd === "read_text_file") throw "no such file";
        if (cmd === "path_exists") return exists;
        return undefined;
      });
    }

    it("marks the note missing when the file is gone", async () => {
      const doc = await opened();
      gone(false);
      await doc.onExternalChange("/v/a.md");
      expect(doc.missing()).toBe(true);
      expect(doc.content()).toBe("old");
    });

    it("does not mark it missing while the file is only being replaced", async () => {
      const doc = await opened();
      gone(true);
      await doc.onExternalChange("/v/a.md");
      expect(doc.missing()).toBe(false);
    });

    it("clears the state when the file returns", async () => {
      const doc = await opened();
      gone(false);
      await doc.onExternalChange("/v/a.md");
      invoke.mockReset();
      invoke.mockResolvedValue("back");
      await doc.onExternalChange("/v/a.md");
      expect(doc.missing()).toBe(false);
      expect(doc.content()).toBe("back");
    });

    it("clears the state when another note is opened or the note is closed", async () => {
      const doc = await opened();
      gone(false);
      await doc.onExternalChange("/v/a.md");
      doc.close();
      expect(doc.missing()).toBe(false);
    });
  });
});

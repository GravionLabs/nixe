import { beforeEach, describe, expect, it, vi } from "vitest";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

import { DocumentService, MAX_HISTORY } from "./document.service";

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

  it("writes only while the disk holds the expected text when one is given", async () => {
    const doc = await opened();
    await doc.write("/v/a.md", "new", "old");
    expect(invoke).toHaveBeenCalledWith("replace_text_file", {
      path: "/v/a.md",
      expected: "old",
      content: "new",
    });
    expect(invoke).not.toHaveBeenCalledWith("write_text_file", expect.anything());
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

describe("DocumentService history", () => {
  let line: number | null;
  async function doc(): Promise<DocumentService> {
    invoke.mockReset();
    invoke.mockImplementation(async (cmd: string) => (cmd === "read_text_file" ? "text" : "/v"));
    line = 1;
    const d = new DocumentService();
    d.positionHook = () => line;
    await d.open("/v/a.md");
    return d;
  }
  const paths = (d: DocumentService) => d.historyState().history.map((e) => e.path);

  it("stores the position of the note that is left and returns to it", async () => {
    const d = await doc();
    line = 12;
    await d.open("/v/b.md", { anchor: "Intro" });
    line = null;
    expect(d.historyState().history).toEqual([
      { path: "/v/a.md", line: 12, anchor: null },
      { path: "/v/b.md", line: null, anchor: "Intro" },
    ]);
    line = 3;
    await d.back();
    expect(d.path()).toBe("/v/a.md");
    expect(d.pendingLine()).toBe(12);
    expect(d.canGoForward()).toBe(true);
    await d.forward();
    expect(d.path()).toBe("/v/b.md");
    expect(d.pendingLine()).toBe(3);
  });

  it("a jump within the note is an entry; back scrolls without reading the note again", async () => {
    const d = await doc();
    line = 40;
    expect(
      d.jump({ anchor: "Unit A" }, () => {
        line = 90;
        return true;
      }),
    ).toBe(true);
    expect(d.canGoBack()).toBe(true);
    invoke.mockClear();
    line = 95;
    await d.back();
    expect(invoke).not.toHaveBeenCalled();
    expect(d.pendingLine()).toBe(40);
    expect(d.canGoBack()).toBe(false);
    expect(d.canGoForward()).toBe(true);
    await d.forward();
    expect(d.pendingLine()).toBe(95);
  });

  it("a jump that does not scroll adds no entry", async () => {
    const d = await doc();
    expect(d.jump({ anchor: "Missing" }, () => false)).toBe(false);
    expect(d.canGoBack()).toBe(false);
  });

  it("adds no entry for the position the reader stands at", async () => {
    const d = await doc();
    await d.open("/v/a.md");
    line = 7;
    d.jump({ line: 7 }, () => true);
    expect(d.canGoBack()).toBe(false);
    d.jump({ anchor: "X" }, () => {
      line = 20;
      return true;
    });
    d.jump({ anchor: "X" }, () => true);
    expect(paths(d)).toEqual(["/v/a.md", "/v/a.md"]);
  });

  it("a second click on the same heading link adds an entry once the reader has scrolled away", async () => {
    const d = await doc();
    line = 40;
    d.jump({ anchor: "X" }, () => {
      line = 60; // landed on the heading
      return true;
    });
    expect(d.historyState().history).toHaveLength(2);
    d.jump({ anchor: "X" }, () => true);
    expect(d.historyState().history).toHaveLength(2);
    line = 90;
    d.jump({ anchor: "X" }, () => true);
    expect(d.historyState().history).toHaveLength(3);
  });

  it("drops the forward entries on a new jump", async () => {
    const d = await doc();
    await d.open("/v/b.md");
    await d.open("/v/c.md");
    await d.back();
    await d.back();
    await d.open("/v/d.md");
    expect(paths(d)).toEqual(["/v/a.md", "/v/d.md"]);
    expect(d.canGoForward()).toBe(false);
  });

  it("reads a list of paths (old format) as entries without a position", async () => {
    const d = await doc();
    d.restoreHistory(["/v/a.md", "/v/b.md"], 1);
    expect(d.historyState().history[0]).toEqual({ path: "/v/a.md", line: null, anchor: null });
    expect(d.canGoBack()).toBe(true);
  });

  it("bounds the list", async () => {
    const d = await doc();
    d.restoreHistory(
      Array.from({ length: 250 }, (_, i) => ({ path: `/v/${i}.md`, line: null, anchor: null })),
      249,
    );
    expect(d.historyState().history).toHaveLength(MAX_HISTORY);
    expect(d.historyState().index).toBe(MAX_HISTORY - 1);
    await d.open("/v/new.md");
    expect(d.historyState().history).toHaveLength(MAX_HISTORY);
  });
});

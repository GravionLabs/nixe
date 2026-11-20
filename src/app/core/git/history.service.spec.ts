// @vitest-environment jsdom
import "@angular/compiler";
import { signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { BrowserTestingModule, platformBrowserTesting } from "@angular/platform-browser/testing";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

import type { GitStatus, HistoryEntry } from "../file/backend";
import { backend } from "../file/backend";
import { EditorService } from "../editor/editor.service";
import { DocumentService } from "../file/document.service";
import { IndexService } from "../index/index.service";
import { WorkspaceService } from "../workspace/workspace.service";
import { GitService } from "./git.service";
import { HistoryService, PAGE_SIZE, relativeTo } from "./history.service";

function entry(n: number, extra: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    id: `c${n}`,
    author: "A",
    time: 1000 + n,
    message: `m${n}`,
    path: "a.md",
    parent: `c${n - 1}`,
    parentPath: "a.md",
    operation: null,
    ...extra,
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("relativeTo", () => {
  it("strips the vault root and refuses files outside it", () => {
    expect(relativeTo("/vault", "/vault/dir/a.md")).toBe("dir/a.md");
    expect(relativeTo("/vault/", "/vault/a.md")).toBe("a.md");
    expect(relativeTo("/vault", "/other/a.md")).toBeNull();
    expect(relativeTo("/vault", "/vault2/a.md")).toBeNull();
  });
});

describe("HistoryService", () => {
  const path = signal<string | null>("/vault/a.md");
  const status = signal<GitStatus | null>(null);
  const revision = signal(0);
  let history: HistoryService;
  let log: ReturnType<typeof vi.spyOn>;
  let version: ReturnType<typeof vi.spyOn>;
  const open = vi.fn();
  const refresh = vi.fn();
  const reloadTree = vi.fn();
  const flush_ = vi.fn();

  beforeAll(() => {
    TestBed.initTestEnvironment(BrowserTestingModule, platformBrowserTesting());
  });

  beforeEach(() => {
    vi.restoreAllMocks();
    path.set("/vault/a.md");
    status.set({ branch: "main", changes: [], ahead: 0, behind: 0 });
    revision.set(0);
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        { provide: DocumentService, useValue: { path, open } },
        { provide: WorkspaceService, useValue: { vaultRoot: signal("/vault"), reloadTree } },
        { provide: IndexService, useValue: { revision } },
        { provide: GitService, useValue: { status, refresh, available: () => status() !== null } },
        { provide: EditorService, useValue: { handle: { flush: flush_ } } },
      ],
    });
    log = vi
      .spyOn(backend, "gitNoteHistory")
      .mockResolvedValue([entry(2), entry(1, { parent: null })]);
    version = vi
      .spyOn(backend, "gitNoteVersion")
      .mockImplementation(async (_p, rev) => `text@${rev}`);
    vi.spyOn(backend, "gitDeletedNotes").mockResolvedValue([]);
    open.mockReset().mockResolvedValue(undefined);
    refresh.mockReset().mockResolvedValue(undefined);
    reloadTree.mockReset().mockResolvedValue(undefined);
    flush_.mockReset().mockResolvedValue(undefined);
    history = TestBed.inject(HistoryService);
  });

  async function ready() {
    TestBed.tick();
    await flush();
  }

  it("lists the commits of the open note", async () => {
    await ready();
    expect(log).toHaveBeenCalledWith("a.md", 0, PAGE_SIZE);
    expect(history.timeline().map((t) => t.id)).toEqual(["c2", "c1"]);
    expect(history.exhausted()).toBe(true);
  });

  it("puts the uncommitted state first when the note has changes", async () => {
    status.set({
      branch: "main",
      changes: [{ path: "a.md", kind: "modified" }],
      ahead: 0,
      behind: 0,
    });
    await ready();
    expect(history.timeline().map((t) => t.id)).toEqual([null, "c2", "c1"]);
    expect(history.timeline()[0].message).toBe("Uncommitted changes");
  });

  it("has no history without a note or a repository", async () => {
    path.set(null);
    await ready();
    expect(history.notePath()).toBeNull();
    expect(log).not.toHaveBeenCalled();
    path.set("/elsewhere/a.md");
    expect(history.notePath()).toBeNull();
  });

  it("loads older pages with the count of loaded entries as offset", async () => {
    const page = Array.from({ length: PAGE_SIZE }, (_, i) => entry(1000 - i));
    log.mockResolvedValueOnce(page).mockResolvedValueOnce([entry(5)]);
    await ready();
    expect(history.exhausted()).toBe(false);
    await history.loadMore();
    expect(log).toHaveBeenLastCalledWith("a.md", PAGE_SIZE, PAGE_SIZE);
    expect(history.commits().length).toBe(PAGE_SIZE + 1);
    expect(history.exhausted()).toBe(true);
    await history.loadMore();
    expect(log).toHaveBeenCalledTimes(2);
  });

  it("shows the change of one commit against its parent", async () => {
    await ready();
    await history.select(history.timeline()[0]);
    expect(history.comparison()).toMatchObject({
      oldText: "text@c1",
      newText: "text@c2",
      newLabel: "c2",
    });
  });

  it("shows a first commit against an empty note", async () => {
    await ready();
    await history.select(history.timeline()[1]);
    expect(history.comparison()?.oldText).toBe("");
    expect(history.comparison()?.newText).toBe("text@c1");
  });

  it("reads the old name of a renamed note for the parent side", async () => {
    log.mockResolvedValue([entry(2, { path: "b.md", parentPath: "a.md" })]);
    await ready();
    await history.reload();
    await history.select(history.timeline()[0]);
    expect(version).toHaveBeenCalledWith("a.md", "c1");
    expect(version).toHaveBeenCalledWith("b.md", "c2");
  });

  it("compares two selected versions, older on the old side, in any click order", async () => {
    await ready();
    const [newer, older] = history.timeline();
    await history.select(older);
    await history.select(newer);
    expect(history.comparison()).toMatchObject({ oldText: "text@c1", newText: "text@c2" });
    // Clicking a selected row deselects it.
    await history.select(newer);
    expect(history.selection()).toEqual(["c1"]);
  });

  it("compares the uncommitted state with HEAD, and with the disk text", async () => {
    status.set({
      branch: "main",
      changes: [{ path: "a.md", kind: "modified" }],
      ahead: 0,
      behind: 0,
    });
    await ready();
    await history.select(history.timeline()[0]);
    expect(history.comparison()).toMatchObject({
      oldText: "text@c2",
      newText: "text@null",
      newLabel: "uncommitted",
    });
  });

  it("keeps timeline, selection and comparison on a status or revision change (#289)", async () => {
    status.set({
      branch: "main",
      changes: [{ path: "a.md", kind: "modified" }],
      ahead: 0,
      behind: 0,
    });
    await ready();
    await history.select(history.timeline()[0]);
    const before = history.comparison();
    expect(before).not.toBeNull();
    log.mockClear();
    let emptied = false;
    let loadingSeen = false;
    const watch = setInterval(() => {
      if (history.timeline().length === 0) emptied = true;
      if (history.loading()) loadingSeen = true;
    }, 0);
    version.mockImplementation(async (_p, rev) => `new@${rev}`);
    status.set({
      branch: "main",
      changes: [{ path: "a.md", kind: "modified" }],
      ahead: 0,
      behind: 0,
    });
    revision.set(1);
    TestBed.tick();
    await flush();
    await flush();
    clearInterval(watch);
    expect(log).toHaveBeenCalledWith("a.md", 0, PAGE_SIZE);
    expect(emptied).toBe(false);
    expect(loadingSeen).toBe(false);
    expect(history.timeline().map((t) => t.id)).toEqual([null, "c2", "c1"]);
    expect(history.selection()).toEqual([""]);
    expect(history.comparison()).toMatchObject({ newText: "new@null" });
  });

  it("keeps a committed selection and its comparison untouched on a refresh (#289)", async () => {
    await ready();
    await history.select(history.timeline()[0]);
    const commits = history.commits();
    const comparison = history.comparison();
    version.mockClear();
    revision.set(1);
    TestBed.tick();
    await flush();
    await flush();
    expect(history.commits()).toBe(commits);
    expect(history.selection()).toEqual(["c2"]);
    expect(history.comparison()).toBe(comparison);
    expect(version).not.toHaveBeenCalled();
  });

  it("resets the list and the selection when the note changes", async () => {
    await ready();
    await history.select(history.timeline()[0]);
    path.set("/vault/b.md");
    TestBed.tick();
    await flush();
    expect(log).toHaveBeenLastCalledWith("b.md", 0, PAGE_SIZE);
    expect(history.selection()).toEqual([]);
    expect(history.comparison()).toBeNull();
  });

  it("reports a failing log", async () => {
    log.mockRejectedValue(new Error("boom"));
    await ready();
    await history.reload();
    expect(history.error()).toContain("boom");
  });

  it("restores a version through the atomic write and refreshes the Git status", async () => {
    const write = vi.spyOn(backend, "writeTextFile").mockResolvedValue(undefined);
    await ready();
    await history.restore(history.timeline()[1]);
    expect(flush_).toHaveBeenCalled();
    expect(write).toHaveBeenCalledWith("/vault/a.md", "text@c1");
    expect(open).toHaveBeenCalledWith("/vault/a.md", { addToHistory: false });
    expect(refresh).toHaveBeenCalled();
    expect(history.notice()).toBe("Restored c1");
    // The history itself is not rewritten.
    expect(history.commits().map((c) => c.id)).toEqual(["c2", "c1"]);
  });

  it("does not restore the uncommitted state and reports a failing write", async () => {
    const write = vi.spyOn(backend, "writeTextFile").mockRejectedValue(new Error("denied"));
    status.set({
      branch: "main",
      changes: [{ path: "a.md", kind: "modified" }],
      ahead: 0,
      behind: 0,
    });
    await ready();
    await history.restore(history.timeline()[0]);
    expect(write).not.toHaveBeenCalled();
    await history.restore(history.timeline()[1]);
    expect(history.notice()).toContain("denied");
    expect(open).not.toHaveBeenCalled();
  });

  it("lists the deleted notes and restores one from the parent of its deleting commit", async () => {
    const note = {
      path: "dir/gone.md",
      id: "d1",
      parent: "p1",
      author: "A",
      time: 5,
      message: "delete",
    };
    vi.mocked(backend.gitDeletedNotes).mockResolvedValue([note]);
    const dir = vi.spyOn(backend, "createDir").mockResolvedValue(undefined);
    const create = vi.spyOn(backend, "createFile").mockResolvedValue(undefined);
    const write = vi.spyOn(backend, "writeTextFile").mockResolvedValue(undefined);
    await ready();
    expect(history.deleted()).toEqual([note]);
    await history.restoreDeleted(note);
    expect(dir).toHaveBeenCalledWith("/vault/dir");
    expect(create).toHaveBeenCalledWith("/vault/dir/gone.md");
    expect(version).toHaveBeenCalledWith("dir/gone.md", "p1");
    expect(write).toHaveBeenCalledWith("/vault/dir/gone.md", "text@p1");
    expect(open).toHaveBeenCalledWith("/vault/dir/gone.md");
    expect(history.notice()).toBe("Restored dir/gone.md");
  });

  it("does not overwrite an existing file when restoring a deleted note", async () => {
    vi.spyOn(backend, "createDir").mockResolvedValue(undefined);
    vi.spyOn(backend, "createFile").mockRejectedValue(new Error("exists"));
    const write = vi.spyOn(backend, "writeTextFile").mockResolvedValue(undefined);
    await history.restoreDeleted({
      path: "g.md",
      id: "d",
      parent: "p",
      author: "",
      time: 0,
      message: "",
    });
    expect(write).not.toHaveBeenCalled();
    expect(history.notice()).toContain("exists");
  });

  it("has no deleted notes without a repository", async () => {
    status.set(null);
    await ready();
    expect(history.deleted()).toEqual([]);
  });
});

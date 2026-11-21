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
import { CompareService } from "../compare/compare.service";
import { EditorService } from "../editor/editor.service";
import { DocumentService } from "../file/document.service";
import { IndexService } from "../index/index.service";
import { VaultUndoService } from "../workspace/vault-undo.service";
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
  const openCompare = vi.fn();
  const undoNotice = signal<unknown>(null);

  beforeAll(() => {
    TestBed.initTestEnvironment(BrowserTestingModule, platformBrowserTesting());
  });

  beforeEach(() => {
    vi.restoreAllMocks();
    path.set("/vault/a.md");
    status.set({ branch: "main", changes: [], ahead: 0, behind: 0, hasRemote: true });
    revision.set(0);
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        { provide: DocumentService, useValue: { path, open } },
        { provide: WorkspaceService, useValue: { vaultRoot: signal("/vault"), reloadTree } },
        { provide: IndexService, useValue: { revision } },
        { provide: GitService, useValue: { status, refresh, available: () => status() !== null } },
        { provide: EditorService, useValue: { handle: { flush: flush_ } } },
        { provide: CompareService, useValue: { open: openCompare } },
        { provide: VaultUndoService, useValue: { notice: undoNotice, author: () => ({}) } },
      ],
    });
    log = vi
      .spyOn(backend, "gitNoteHistory")
      .mockResolvedValue([entry(2), entry(1, { parent: null })]);
    version = vi
      .spyOn(backend, "gitNoteVersion")
      .mockImplementation(async (_p, rev) => `text@${rev}`);
    vi.spyOn(backend, "gitDeletedNotes").mockResolvedValue([]);
    vi.spyOn(backend, "gitRecentNotes").mockResolvedValue([]);
    open.mockReset().mockResolvedValue(undefined);
    refresh.mockReset().mockResolvedValue(undefined);
    reloadTree.mockReset().mockResolvedValue(undefined);
    flush_.mockReset().mockResolvedValue(undefined);
    openCompare.mockReset();
    undoNotice.set(null);
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
      hasRemote: true,
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

  it("opens the change of one commit against its parent in the main area", async () => {
    await ready();
    await history.open(history.timeline()[0]);
    expect(openCompare).toHaveBeenCalledWith(
      expect.objectContaining({
        path: "a.md",
        title: "a",
        oldText: "text@c1",
        newText: "text@c2",
        newLabel: "c2",
      }),
    );
  });

  it("opens a first commit against an empty note", async () => {
    await ready();
    await history.open(history.timeline()[1]);
    const input = openCompare.mock.calls[0][0];
    expect(input.oldText).toBe("");
    expect(input.newText).toBe("text@c1");
  });

  it("reads the old name of a renamed note for the parent side", async () => {
    log.mockResolvedValue([entry(2, { path: "b.md", parentPath: "a.md" })]);
    await ready();
    await history.reload();
    await history.open(history.timeline()[0]);
    expect(version).toHaveBeenCalledWith("a.md", "c1");
    expect(version).toHaveBeenCalledWith("b.md", "c2");
  });

  it("compares two versions with the older on the old side, in any order", async () => {
    await ready();
    const [newer, older] = history.timeline();
    await history.compareBetween(older, newer);
    expect(openCompare.mock.calls[0][0]).toMatchObject({ oldText: "text@c1", newText: "text@c2" });
    await history.compareBetween(newer, older);
    expect(openCompare.mock.calls[1][0]).toMatchObject({ oldText: "text@c1", newText: "text@c2" });
  });

  it("compares a version with the current text of the note", async () => {
    await ready();
    await history.compareWithCurrent(history.timeline()[1]);
    expect(openCompare.mock.calls[0][0]).toMatchObject({
      oldText: "text@c1",
      newText: "text@null",
      oldLabel: "c1",
      newLabel: "current",
    });
  });

  it("compares the uncommitted state with HEAD", async () => {
    status.set({
      branch: "main",
      changes: [{ path: "a.md", kind: "modified" }],
      ahead: 0,
      behind: 0,
      hasRemote: true,
    });
    await ready();
    await history.open(history.timeline()[0]);
    expect(openCompare.mock.calls[0][0]).toMatchObject({
      oldText: "text@c2",
      newText: "text@null",
      newLabel: "uncommitted",
    });
  });

  it("keeps the timeline on a status or revision change without a loading state (#289)", async () => {
    status.set({
      branch: "main",
      changes: [{ path: "a.md", kind: "modified" }],
      ahead: 0,
      behind: 0,
      hasRemote: true,
    });
    await ready();
    log.mockClear();
    let emptied = false;
    let loadingSeen = false;
    const watch = setInterval(() => {
      if (history.timeline().length === 0) emptied = true;
      if (history.loading()) loadingSeen = true;
    }, 0);
    status.set({
      branch: "main",
      changes: [{ path: "a.md", kind: "modified" }],
      ahead: 0,
      behind: 0,
      hasRemote: true,
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
  });

  it("keeps the loaded commits untouched on a refresh without changes (#289)", async () => {
    await ready();
    const commits = history.commits();
    revision.set(1);
    TestBed.tick();
    await flush();
    await flush();
    expect(history.commits()).toBe(commits);
  });

  it("reports a failing log", async () => {
    log.mockRejectedValue(new Error("boom"));
    await ready();
    await history.reload();
    expect(history.error()).toContain("boom");
  });

  it("shows what a restore brings with a Restore button that restores and offers Undo", async () => {
    const restore = vi
      .spyOn(backend, "gitRestoreNote")
      .mockResolvedValue({ id: "r1", kind: "restore", message: "restore: a.md to c1" });
    await ready();
    await history.reviewRestore(history.timeline()[1]);
    const input = openCompare.mock.calls[0][0];
    expect(input).toMatchObject({ oldText: "text@null", newText: "text@c1", oldLabel: "current" });
    expect(input.action).toMatchObject({
      label: "Restore",
      note: "The current version stays in the history",
    });
    expect(restore).not.toHaveBeenCalled();
    expect(await input.action.run()).toBe(true);
    expect(flush_).toHaveBeenCalled();
    expect(restore).toHaveBeenCalledWith("a.md", "a.md", "c1", {});
    expect(open).toHaveBeenCalledWith("/vault/a.md", { addToHistory: false });
    expect(refresh).toHaveBeenCalled();
    expect(undoNotice()).toEqual({ text: "restore: a.md to c1", undo: true, error: false });
  });

  it("does not restore the uncommitted state and reports a failing restore", async () => {
    const restore = vi.spyOn(backend, "gitRestoreNote").mockRejectedValue(new Error("denied"));
    status.set({
      branch: "main",
      changes: [{ path: "a.md", kind: "modified" }],
      ahead: 0,
      behind: 0,
      hasRemote: true,
    });
    await ready();
    expect(await history.restore(history.timeline()[0])).toBe(false);
    await history.reviewRestore(history.timeline()[0]);
    expect(openCompare).not.toHaveBeenCalled();
    expect(restore).not.toHaveBeenCalled();
    expect(await history.restore(history.timeline()[1])).toBe(false);
    expect(history.notice()).toContain("denied");
    expect(open).not.toHaveBeenCalled();
    expect(undoNotice()).toBeNull();
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

  it("shows the last content of a deleted note with a Restore button", async () => {
    const note = { path: "d/g.md", id: "d1", parent: "p1", author: "", time: 5, message: "" };
    await history.reviewDeleted(note);
    const input = openCompare.mock.calls[0][0];
    expect(input).toMatchObject({ path: "d/g.md", oldText: null, newText: "text@p1" });
    vi.spyOn(backend, "createDir").mockResolvedValue(undefined);
    vi.spyOn(backend, "createFile").mockResolvedValue(undefined);
    vi.spyOn(backend, "writeTextFile").mockResolvedValue(undefined);
    expect(await input.action.run()).toBe(true);
    expect(open).toHaveBeenCalledWith("/vault/d/g.md");
  });

  it("reports a failed restore of a deleted note", async () => {
    vi.spyOn(backend, "createDir").mockResolvedValue(undefined);
    vi.spyOn(backend, "createFile").mockRejectedValue(new Error("exists"));
    const note = { path: "g.md", id: "d", parent: "p", author: "", time: 0, message: "" };
    expect(await history.restoreDeleted(note)).toBe(false);
  });

  it("loads the recently changed notes and opens one", async () => {
    const note = { path: "dir/r.md", id: "r", author: "A", time: 9, message: "m" };
    vi.mocked(backend.gitRecentNotes).mockResolvedValue([note]);
    await ready();
    expect(history.recent()).toEqual([note]);
    await history.openRecent(note);
    expect(open).toHaveBeenCalledWith("/vault/dir/r.md");
  });

  it("has no recent notes without a repository", async () => {
    status.set(null);
    await ready();
    expect(history.recent()).toEqual([]);
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

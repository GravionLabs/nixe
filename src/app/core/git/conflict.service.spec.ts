// @vitest-environment jsdom
import "@angular/compiler";
import { signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { BrowserTestingModule, platformBrowserTesting } from "@angular/platform-browser/testing";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

import { EditorService } from "../editor/editor.service";
import { backend } from "../file/backend";
import { DocumentService } from "../file/document.service";
import { IndexService } from "../index/index.service";
import { WorkspaceService } from "../workspace/workspace.service";
import { ConflictService } from "./conflict.service";

const pair = { original: "/v/Note.md", copy: "/v/Note (conflict 2026-11-16 mac).md" };

describe("ConflictService", () => {
  const path = signal<string | null>("/v/Note.md");
  const revision = signal(0);
  const open = vi.fn();
  const reloadTree = vi.fn();
  const flush = vi.fn();
  const write = vi.fn();
  const editing = signal(true);
  let service: ConflictService;

  beforeAll(() => {
    TestBed.initTestEnvironment(BrowserTestingModule, platformBrowserTesting());
  });

  beforeEach(() => {
    path.set("/v/Note.md");
    editing.set(true);
    vi.restoreAllMocks();
    open.mockReset().mockResolvedValue(undefined);
    reloadTree.mockReset().mockResolvedValue(undefined);
    write.mockReset().mockResolvedValue(undefined);
    flush.mockReset().mockResolvedValue(undefined);
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        { provide: DocumentService, useValue: { path, open, write } },
        { provide: EditorService, useValue: { handle: { flush }, editing } },
        { provide: IndexService, useValue: { revision } },
        { provide: WorkspaceService, useValue: { reloadTree } },
      ],
    });
    vi.spyOn(backend, "conflictPair").mockResolvedValue(pair);
    service = TestBed.inject(ConflictService);
  });

  it("knows the pair of the open note and which half it is", async () => {
    await service.refresh();
    expect(service.pair()).toEqual(pair);
    expect(service.isCopy()).toBe(false);
    expect(service.other()).toBe(pair.copy);
    path.set(pair.copy);
    expect(service.isCopy()).toBe(true);
    expect(service.other()).toBe(pair.original);
  });

  it("has no pair for an ordinary note, no note or a failing backend", async () => {
    vi.spyOn(backend, "conflictPair").mockResolvedValue(null);
    await service.refresh();
    expect(service.pair()).toBeNull();
    path.set(null);
    await service.refresh();
    expect(service.pair()).toBeNull();
    vi.spyOn(backend, "conflictPair").mockRejectedValue(new Error("x"));
    await service.refresh("/v/a.md");
    expect(service.pair()).toBeNull();
  });

  it("opens the other half", async () => {
    await service.refresh();
    await service.openOther();
    expect(open).toHaveBeenCalledWith(pair.copy);
  });

  it("keeps a text: flushes, resolves, shows the original and reloads the tree", async () => {
    await service.refresh();
    const resolve = vi.spyOn(backend, "resolveConflict").mockResolvedValue(pair.original);
    vi.spyOn(backend, "conflictPair").mockResolvedValue(null);
    await service.keep("other");
    expect(flush).toHaveBeenCalled();
    expect(resolve).toHaveBeenCalledWith("/v/Note.md", "other");
    expect(editing()).toBe(false);
    expect(open).toHaveBeenCalledWith(pair.original, { addToHistory: false });
    expect(reloadTree).toHaveBeenCalled();
    expect(service.pair()).toBeNull();
  });

  it("does nothing without a pair", async () => {
    vi.spyOn(backend, "conflictPair").mockResolvedValue(null);
    await service.refresh();
    const resolve = vi.spyOn(backend, "resolveConflict");
    await service.keep("this");
    expect(resolve).not.toHaveBeenCalled();
  });

  it("opens a merge with both texts and cancel changes nothing", async () => {
    await service.refresh();
    const read = vi
      .spyOn(backend, "readTextFile")
      .mockImplementation(async (p) => (p === pair.original ? "a\n" : "b\n"));
    const resolve = vi.spyOn(backend, "resolveConflict");
    await service.startMerge();
    expect(flush).toHaveBeenCalled();
    expect(read).toHaveBeenCalledTimes(2);
    expect(service.merging()).toEqual({ mine: "a\n", theirs: "b\n" });
    service.cancelMerge();
    expect(service.merging()).toBeNull();
    expect(write).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
  });

  it("saves a merge: writes the original, removes the copy and clears the mark", async () => {
    await service.refresh();
    path.set(pair.copy);
    const resolve = vi.spyOn(backend, "resolveConflict").mockResolvedValue(pair.original);
    vi.spyOn(backend, "conflictPair").mockResolvedValue(null);
    service.merging.set({ mine: "a", theirs: "b" });
    await service.saveMerge("a\nb");
    expect(write).toHaveBeenCalledWith(pair.original, "a\nb");
    expect(resolve).toHaveBeenCalledWith(pair.original, "this");
    expect(service.merging()).toBeNull();
    expect(open).toHaveBeenCalledWith(pair.original, { addToHistory: false });
    expect(service.pair()).toBeNull();
  });
});

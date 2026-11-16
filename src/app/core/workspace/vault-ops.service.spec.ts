// @vitest-environment jsdom
import "@angular/compiler";
import { signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { BrowserTestingModule, platformBrowserTesting } from "@angular/platform-browser/testing";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ ask: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ revealItemInDir: vi.fn() }));

import { ask } from "@tauri-apps/plugin-dialog";

import { EditorService } from "../editor/editor.service";
import { backend } from "../file/backend";
import { DocumentService } from "../file/document.service";
import { VaultOpsService } from "./vault-ops.service";
import { WorkspaceService } from "./workspace.service";

describe("VaultOpsService", () => {
  const path = signal<string | null>(null);
  const doc = { path, open: vi.fn(), close: vi.fn() };
  const workspace = { vaultRoot: signal("/v"), reloadTree: vi.fn() };
  const editor = { editing: signal(false), handle: null };
  let ops: VaultOpsService;

  beforeAll(() => {
    TestBed.initTestEnvironment(BrowserTestingModule, platformBrowserTesting());
  });

  beforeEach(() => {
    vi.restoreAllMocks();
    doc.open = vi.fn().mockResolvedValue(undefined);
    doc.close = vi.fn();
    workspace.reloadTree = vi.fn().mockResolvedValue(undefined);
    path.set(null);
    editor.editing.set(false);
    vi.spyOn(backend, "newNoteLocation").mockResolvedValue({ location: "root", folder: "" });
    vi.spyOn(backend, "listDir").mockResolvedValue([]);
    vi.spyOn(backend, "createDir").mockResolvedValue(undefined);
    vi.spyOn(backend, "createFile").mockResolvedValue(undefined);
    vi.spyOn(backend, "renamePath").mockResolvedValue([]);
    vi.spyOn(backend, "isDir").mockResolvedValue(false);
    vi.spyOn(backend, "relinkPreview").mockResolvedValue([]);
    vi.mocked(ask).mockReset();
    vi.mocked(ask).mockResolvedValue(true);
    vi.spyOn(backend, "trashPath").mockResolvedValue("/v/.trash/x");
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        { provide: WorkspaceService, useValue: workspace },
        { provide: DocumentService, useValue: doc },
        { provide: EditorService, useValue: editor },
      ],
    });
    ops = TestBed.inject(VaultOpsService);
  });

  it("creates Untitled.md in the vault root and opens it", async () => {
    await expect(ops.createNote()).resolves.toBe("/v/Untitled.md");
    expect(backend.createFile).toHaveBeenCalledWith("/v/Untitled.md");
    expect(doc.open).toHaveBeenCalledWith("/v/Untitled.md");
    expect(workspace.reloadTree).toHaveBeenCalled();
  });

  it("numbers the name when it is taken", async () => {
    vi.spyOn(backend, "listDir").mockResolvedValue([
      { name: "Untitled.md", path: "/v/Untitled.md", isDir: false, hasOrder: false },
    ]);
    await expect(ops.createNote()).resolves.toBe("/v/Untitled 1.md");
  });

  it("uses the folder of app.json", async () => {
    vi.spyOn(backend, "newNoteLocation").mockResolvedValue({ location: "folder", folder: "Inbox" });
    await expect(ops.createNote()).resolves.toBe("/v/Inbox/Untitled.md");
    expect(backend.createDir).toHaveBeenCalledWith("/v/Inbox");
  });

  it("uses the folder of the open note for the setting `current`", async () => {
    vi.spyOn(backend, "newNoteLocation").mockResolvedValue({ location: "current", folder: "" });
    path.set("/v/work/a.md");
    await expect(ops.createNote()).resolves.toBe("/v/work/Untitled.md");
  });

  it("falls back to the root when the setting cannot be read", async () => {
    vi.spyOn(backend, "newNoteLocation").mockRejectedValue("x");
    await expect(ops.createNote()).resolves.toBe("/v/Untitled.md");
  });

  it("creates the target of an unresolved link by the same rule", async () => {
    vi.spyOn(backend, "newNoteLocation").mockResolvedValue({ location: "folder", folder: "Inbox" });
    await expect(ops.createNoteForLink("Idea")).resolves.toBe("/v/Inbox/Idea.md");
    expect(doc.open).toHaveBeenCalledWith("/v/Inbox/Idea.md");
    await expect(ops.createNoteForLink("a/b/Deep")).resolves.toBe("/v/a/b/Deep.md");
    await expect(ops.createNoteForLink("  ")).resolves.toBeNull();
  });

  it("creates a numbered folder", async () => {
    vi.spyOn(backend, "listDir").mockResolvedValue([
      { name: "Untitled", path: "/v/Untitled", isDir: true, hasOrder: false },
    ]);
    await expect(ops.createFolder("/v")).resolves.toBe("/v/Untitled 1");
    expect(backend.createDir).toHaveBeenCalledWith("/v/Untitled 1");
  });

  it("renames and follows the open note", async () => {
    path.set("/v/d/a.md");
    await expect(ops.rename("/v/d", "e")).resolves.toBe("/v/e");
    expect(backend.renamePath).toHaveBeenCalledWith("/v/d", "/v/e");
    expect(doc.open).toHaveBeenCalledWith("/v/e/a.md", { addToHistory: false });
  });

  it("lists the notes a folder rename changes and renames after the user agrees", async () => {
    vi.spyOn(backend, "isDir").mockResolvedValue(true);
    vi.spyOn(backend, "relinkPreview").mockResolvedValue([{ path: "a.md", links: 2 }]);
    await expect(ops.rename("/v/d", "e")).resolves.toBe("/v/e");
    expect(backend.relinkPreview).toHaveBeenCalledWith("/v/d", "/v/e");
    expect(vi.mocked(ask).mock.calls[0][0]).toContain("a.md (2)");
    expect(backend.renamePath).toHaveBeenCalledWith("/v/d", "/v/e");
  });

  it("does not rename a folder when the user declines the confirmation", async () => {
    vi.spyOn(backend, "isDir").mockResolvedValue(true);
    vi.spyOn(backend, "relinkPreview").mockResolvedValue([{ path: "a.md", links: 1 }]);
    vi.mocked(ask).mockResolvedValue(false);
    await expect(ops.rename("/v/d", "e")).resolves.toBe("/v/d");
    expect(backend.renamePath).not.toHaveBeenCalled();
    expect(workspace.reloadTree).not.toHaveBeenCalled();
  });

  it("renames a folder without asking when no link changes", async () => {
    vi.spyOn(backend, "isDir").mockResolvedValue(true);
    await ops.rename("/v/d", "e");
    expect(ask).not.toHaveBeenCalled();
    expect(backend.renamePath).toHaveBeenCalled();
  });

  it("renames a note without asking", async () => {
    await ops.rename("/v/a.md", "b");
    expect(backend.relinkPreview).not.toHaveBeenCalled();
    expect(ask).not.toHaveBeenCalled();
  });

  it("keeps .md when a note is renamed without an extension", async () => {
    await ops.rename("/v/a.md", "b");
    expect(backend.renamePath).toHaveBeenCalledWith("/v/a.md", "/v/b.md");
    expect(doc.open).not.toHaveBeenCalled();
  });

  it("refuses an invalid name before it calls the backend", async () => {
    await expect(ops.rename("/v/a.md", "x/y")).rejects.toThrow();
    expect(backend.renamePath).not.toHaveBeenCalled();
  });

  it("trashes a note and closes it when it was open", async () => {
    path.set("/v/a.md");
    editor.editing.set(true);
    await ops.trash("/v/a.md");
    expect(backend.trashPath).toHaveBeenCalledWith("/v/a.md");
    expect(doc.close).toHaveBeenCalled();
    expect(editor.editing()).toBe(false);
  });

  it("keeps the open note when another one is trashed", async () => {
    path.set("/v/a.md");
    await ops.trash("/v/b.md");
    expect(doc.close).not.toHaveBeenCalled();
    expect(workspace.reloadTree).toHaveBeenCalled();
  });
});

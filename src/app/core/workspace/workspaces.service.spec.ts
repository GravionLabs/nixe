// @vitest-environment jsdom
import "@angular/compiler";
import { signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { BrowserTestingModule, platformBrowserTesting } from "@angular/platform-browser/testing";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

import type { Workspace } from "../file/backend";
import { backend } from "../file/backend";
import { CommandRegistry } from "../commands/command-registry";
import { DocumentService } from "../file/document.service";
import { WorkspaceService } from "./workspace.service";
import { WorkspacesService, defaultWorkspaceName } from "./workspaces.service";

const root = (path: string, name: string, kind: "folder" | "obsidian" = "folder") => ({
  path,
  name,
  kind,
});

describe("WorkspacesService", () => {
  let service: WorkspacesService;
  let workspace: WorkspaceService;
  let commands: CommandRegistry;
  let stored: Map<string, Workspace>;

  beforeAll(() => {
    TestBed.initTestEnvironment(BrowserTestingModule, platformBrowserTesting());
  });

  beforeEach(() => {
    localStorage.clear();
    window.matchMedia = vi.fn().mockReturnValue({ matches: false, addEventListener: vi.fn() });
    stored = new Map();
    vi.spyOn(backend, "isFile").mockResolvedValue(false);
    vi.spyOn(backend, "isDir").mockResolvedValue(true);
    vi.spyOn(backend, "listDir").mockResolvedValue([]);
    vi.spyOn(backend, "findVaultRoot").mockImplementation(async (p) => p);
    vi.spyOn(backend, "importObsidianSettings").mockResolvedValue({
      written: [],
      sources: [],
      warnings: [],
    });
    vi.spyOn(backend, "listVaultFiles").mockResolvedValue([]);
    vi.spyOn(backend, "indexStart").mockResolvedValue(undefined);
    vi.spyOn(backend, "workspaceIndex").mockResolvedValue(undefined);
    vi.spyOn(backend, "workspaceAddRoot").mockImplementation(async (ws, path) => ({
      ...ws,
      roots: [...ws.roots, root(path, path.split("/").pop()!)],
    }));
    vi.spyOn(backend, "workspaceSave").mockImplementation(
      async (ws) => void stored.set(ws.name, ws),
    );
    vi.spyOn(backend, "workspaceLoad").mockImplementation(async (n) => stored.get(n)!);
    vi.spyOn(backend, "workspaceList").mockImplementation(async () => [...stored.keys()].sort());
    vi.spyOn(backend, "workspaceDelete").mockImplementation(async (n) => void stored.delete(n));
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [{ provide: DocumentService, useValue: { path: signal(null), open: vi.fn() } }],
    });
    service = TestBed.inject(WorkspacesService);
    workspace = TestBed.inject(WorkspaceService);
    commands = TestBed.inject(CommandRegistry);
  });

  it("adds folders as further roots below the open one", async () => {
    await workspace.openFolder("/a", { openDefaultPage: false });
    await service.addFolder("/b");
    await service.addFolder("/c");
    expect(service.current()?.roots.map((r) => r.path)).toEqual(["/a", "/b", "/c"]);
    expect(workspace.extraRoots().map((n) => [n.name, n.dirPath])).toEqual([
      ["b", "/b"],
      ["c", "/c"],
    ]);
  });

  it("covers search and switcher with all roots once there are several, and indexes them (#117)", async () => {
    await workspace.openFolder("/a", { openDefaultPage: false });
    expect(service.searchRoots()).toBeNull();
    await service.addFolder("/b");
    expect(service.searchRoots()).toEqual([
      { path: "/a", name: "a" },
      { path: "/b", name: "b" },
    ]);
    expect(backend.workspaceIndex).toHaveBeenCalledWith(service.searchRoots());
    await vi.waitFor(() => expect(service.indexRevision()).toBe(1));
    vi.mocked(backend.workspaceIndex).mockRejectedValueOnce("boom");
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await service.addFolder("/c");
    await vi.waitFor(() => expect(service.indexRevision()).toBe(2));
  });

  it("needs an open folder before the first root", async () => {
    await expect(service.addFolder("/b")).rejects.toThrow("Open a folder first.");
  });

  it("shows the extra roots as rows and drops them when another folder opens", async () => {
    await workspace.openFolder("/a", { openDefaultPage: false });
    await service.addFolder("/b");
    expect(workspace.visible().map((n) => n.dirPath)).toEqual(["/b"]);
    await workspace.openFolder("/z", { openDefaultPage: false });
    expect(workspace.extraRoots()).toEqual([]);
  });

  it("saves under a name, lists it as a command and reopens it", async () => {
    await workspace.openFolder("/a", { openDefaultPage: false });
    await service.addFolder("/b");
    expect(await service.save()).toBe("a + b");
    expect(service.saved()).toEqual(["a + b"]);
    expect(commands.get("open-workspace:a + b")?.title).toBe("Open workspace: a + b");

    await workspace.openFolder("/z", { openDefaultPage: false });
    await service.openSaved("a + b");
    expect(workspace.root()).toBe("/a");
    expect(workspace.extraRoots().map((n) => n.dirPath)).toEqual(["/b"]);
  });

  it("skips a saved root whose folder is gone", async () => {
    stored.set("w", {
      name: "w",
      roots: [root("/gone", "gone"), root("/b", "b"), root("/c", "c")],
    });
    vi.spyOn(backend, "isDir").mockImplementation(async (p) => p !== "/gone");
    await service.openSaved("w");
    expect(workspace.root()).toBe("/b");
    expect(workspace.extraRoots().map((n) => n.dirPath)).toEqual(["/c"]);
  });

  it("ends the workspace when another folder opens", async () => {
    await workspace.openFolder("/a", { openDefaultPage: false });
    await service.addFolder("/b");
    await workspace.openFolder("/z", { openDefaultPage: false });
    TestBed.tick();
    expect(service.current()).toBeNull();
  });

  it("resolves a root-prefixed link and links inside a further root, not ordinary ones", async () => {
    const resolve = vi
      .spyOn(backend, "workspaceResolveLinks")
      .mockResolvedValue([{ root: "/b", path: "Todo.md" }]);
    expect(await service.resolveLink("b:Todo", "/a/x.md")).toBeUndefined();
    await workspace.openFolder("/a", { openDefaultPage: false });
    await service.addFolder("/b");
    expect(await service.resolveLink("Todo", "/a/x.md")).toBeUndefined();
    expect(await service.resolveLink("Unknown:Todo", "/a/x.md")).toBeUndefined();
    expect(await service.resolveLink("b:Todo", "/a/x.md")).toBe("/b/Todo.md");
    expect(resolve).toHaveBeenLastCalledWith(service.current(), "/a", ["b:Todo"]);
    expect(await service.resolveLink("Todo", "/b/y.md")).toBe("/b/Todo.md");
    expect(resolve).toHaveBeenLastCalledWith(service.current(), "/b", ["Todo"]);
    resolve.mockResolvedValue([null]);
    expect(await service.resolveLink("b:Nope", "/a/x.md")).toBeNull();
  });

  it("forgets a workspace and its command", async () => {
    await workspace.openFolder("/a", { openDefaultPage: false });
    await service.addFolder("/b");
    await service.save("mine");
    await service.forget("mine");
    expect(service.saved()).toEqual([]);
    expect(commands.get("open-workspace:mine")).toBeUndefined();
  });

  it("names an unnamed workspace after its roots, as a safe file name", () => {
    expect(defaultWorkspaceName({ name: "", roots: [root("/a", "a"), root("/b", "b:c")] })).toBe(
      "a + b-c",
    );
    expect(defaultWorkspaceName({ name: "", roots: [] })).toBe("Workspace");
  });
});

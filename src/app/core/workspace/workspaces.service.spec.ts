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
import { WorkspacesService, defaultWorkspaceName, skippedMessage } from "./workspaces.service";

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

  it("renames a root: the name is kept in the workspace, in the tree and in a save (#497)", async () => {
    vi.spyOn(backend, "workspaceRenameRoot").mockImplementation(async (ws, path, name) => ({
      ...ws,
      roots: ws.roots.map((r) => (r.path === path ? { ...r, name } : r)),
    }));
    await workspace.openFolder("/vault", { openDefaultPage: false });
    await service.addFolder("/other/Wiki");
    await service.renameRoot("/other/Wiki", "Books");
    expect(service.current()?.roots.map((r) => r.name)).toEqual(["vault", "Books"]);
    expect(service.rootName("/other/Wiki")).toBe("Books");
    expect(workspace.extraRoots().map((n) => n.name)).toEqual(["Books"]);
    expect(service.searchRoots()?.map((r) => r.name)).toEqual(["vault", "Books"]);
    await service.save("Mine");
    expect(stored.get("Mine")?.roots[1].name).toBe("Books");
  });

  it("needs a workspace to rename a root", async () => {
    await expect(service.renameRoot("/x", "y")).rejects.toThrow("Add a folder");
  });

  it("keeps the name when the backend refuses a rename", async () => {
    vi.spyOn(backend, "workspaceRenameRoot").mockRejectedValue("another root is called x already");
    await workspace.openFolder("/vault", { openDefaultPage: false });
    await service.addFolder("/other/Wiki");
    await expect(service.renameRoot("/other/Wiki", "vault")).rejects.toBe(
      "another root is called x already",
    );
    expect(service.rootName("/other/Wiki")).toBe("Wiki");
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

  it("skips a root with an unresolved variable, reports it once and keeps it for a save", async () => {
    const unresolved = {
      path: "$Books/n",
      template: "$Books/n",
      name: "n",
      kind: "folder" as const,
    };
    stored.set("w", {
      name: "w",
      roots: [root("/a", "a"), unresolved, { ...root("/b", "b"), template: "$Home/b" }],
    });
    vi.spyOn(backend, "isDir").mockImplementation(async (p) => !p.startsWith("$"));
    const save = vi.spyOn(backend, "workspaceSave").mockResolvedValue(undefined);
    await service.openSaved("w");
    expect(service.skipped()).toEqual({ workspace: "w", variables: ["Books"] });
    expect(workspace.root()).toBe("/a");
    expect(workspace.extraRoots().map((n) => n.dirPath)).toEqual(["/b"]);
    await service.save();
    expect(save.mock.lastCall![0].roots).toContainEqual(unresolved);
  });

  it("reports nothing when every variable resolves, and still names them when no root is left", async () => {
    stored.set("ok", { name: "ok", roots: [{ ...root("/h/x", "x"), template: "$Home/x" }] });
    await service.openSaved("ok");
    expect(service.skipped()).toBeNull();
    stored.set("none", {
      name: "none",
      roots: [{ path: "$A/x", template: "$A/x", name: "x", kind: "folder" }],
    });
    vi.spyOn(backend, "isDir").mockResolvedValue(false);
    await expect(service.openSaved("none")).rejects.toThrow("No folder");
    expect(service.skipped()).toEqual({ workspace: "none", variables: ["A"] });
  });

  it("brings the root back when the variable is set and the workspace is reopened", async () => {
    const first = { path: "$Books/n", template: "$Books/n", name: "n", kind: "folder" as const };
    stored.set("w", { name: "w", roots: [root("/a", "a"), first] });
    vi.spyOn(backend, "isDir").mockImplementation(async (p) => !p.startsWith("$"));
    await service.openSaved("w");
    expect(workspace.extraRoots()).toEqual([]);
    stored.set("w", { name: "w", roots: [root("/a", "a"), { ...first, path: "/books/n" }] });
    service.skipped.set(null);
    await service.openSaved("w");
    expect(service.skipped()).toBeNull();
    expect(workspace.extraRoots().map((n) => n.dirPath)).toEqual(["/books/n"]);
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

describe("skippedMessage", () => {
  it("names each variable", () => {
    expect(skippedMessage({ workspace: "w", variables: ["Books"] })).toBe(
      "$Books has no value on this device. The folders that use it are skipped.",
    );
    expect(skippedMessage({ workspace: "w", variables: ["A", "B"] })).toContain("$A, $B have");
  });
});

// @vitest-environment jsdom
import "@angular/compiler";
import { signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { BrowserTestingModule, platformBrowserTesting } from "@angular/platform-browser/testing";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

import { backend } from "../file/backend";
import { DocumentService } from "../file/document.service";
import { SettingsService } from "../settings/settings.service";
import { WorkspaceService } from "./workspace.service";

describe("file tree actions of WorkspaceService", () => {
  const path = signal<string | null>(null);
  let workspace: WorkspaceService;
  let settings: SettingsService;

  const tree: Record<string, { name: string; isDir: boolean; modified: number }[]> = {
    "/v": [
      { name: "docs", isDir: true, modified: 5 },
      { name: "a.md", isDir: false, modified: 10 },
      { name: "b.md", isDir: false, modified: 30 },
    ],
    "/v/docs": [
      { name: "deep", isDir: true, modified: 1 },
      { name: "x.md", isDir: false, modified: 2 },
    ],
    "/v/docs/deep": [{ name: "note.md", isDir: false, modified: 3 }],
  };

  beforeAll(() => {
    TestBed.initTestEnvironment(BrowserTestingModule, platformBrowserTesting());
  });

  beforeEach(async () => {
    localStorage.clear();
    window.matchMedia = vi.fn().mockReturnValue({ matches: false, addEventListener: vi.fn() });
    path.set(null);
    vi.spyOn(backend, "isFile").mockResolvedValue(false);
    vi.spyOn(backend, "isDir").mockResolvedValue(true);
    vi.spyOn(backend, "listDir").mockImplementation(
      async (d) =>
        (tree[d] ?? []).map((e) => ({ ...e, path: `${d}/${e.name}`, hasOrder: false })) as never,
    );
    vi.spyOn(backend, "findVaultRoot").mockImplementation(async (p) => p);
    vi.spyOn(backend, "listVaultFiles").mockResolvedValue([]);
    vi.spyOn(backend, "indexStart").mockResolvedValue(undefined as never);
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [{ provide: DocumentService, useValue: { path, open: vi.fn() } }],
    });
    settings = TestBed.inject(SettingsService);
    workspace = TestBed.inject(WorkspaceService);
    await workspace.openFolder("/v", { openDefaultPage: false });
  });

  const names = () => workspace.visible().map((n) => n.name);

  it("sorts and keeps the choice in the settings", async () => {
    expect(names()).toEqual(["docs", "a.md", "b.md"]);
    await workspace.setSort("modified-desc");
    expect(names()).toEqual(["docs", "b.md", "a.md"]);
    await workspace.setSort("name-desc");
    expect(names()).toEqual(["docs", "b.md", "a.md"]);
    expect(settings.treeSort()).toBe("name-desc");
    expect(workspace.sort()).toBe("name-desc");
  });

  it("sorts the folders that are opened later by the same order", async () => {
    await workspace.setSort("name-desc");
    await workspace.toggle(workspace.visible()[0], true);
    expect(names().slice(1, 3)).toEqual(["deep", "x.md"]);
  });

  it("keeps opened folders open when the order changes", async () => {
    await workspace.toggle(workspace.visible()[0], true);
    await workspace.setSort("modified-asc");
    expect(names()).toContain("x.md");
  });

  it("reveals the open note and asks the sidebar to scroll to it", async () => {
    path.set("/v/docs/deep/note.md");
    const before = workspace.revealRequest();
    await workspace.revealActive();
    expect(names()).toContain("note.md");
    expect(workspace.revealRequest()).toBe(before + 1);
  });

  it("does nothing without an open note", async () => {
    await workspace.revealActive();
    expect(workspace.revealRequest()).toBe(0);
  });

  it("filters by name, loads the folders of matches and clears the filter on a reveal", async () => {
    vi.spyOn(backend, "listVaultFiles").mockResolvedValue(["a.md", "b.md", "docs/deep/note.md", "docs/x.md"]);
    await workspace.openFolder("/v", { openDefaultPage: false });
    await workspace.setTreeFilter("note");
    expect(workspace.filteredRows().map((n) => n.name)).toEqual(["docs", "deep", "note.md"]);
    await workspace.setTreeFilter("DOCS");
    expect(workspace.filteredRows().map((n) => n.name)).toEqual(["docs"]);
    await workspace.setTreeFilter("");
    expect(workspace.filteredRows().map((n) => n.name)).toContain("a.md");
    await workspace.setTreeFilter("x.md");
    path.set("/v/a.md");
    await workspace.revealActive();
    expect(workspace.treeFilter()).toBe("");
  });

  it("collapses every folder", async () => {
    await workspace.reveal("/v/docs/deep/note.md");
    expect(names()).toContain("note.md");
    workspace.collapseAll();
    expect(names()).toEqual(["docs", "a.md", "b.md"]);
  });
});

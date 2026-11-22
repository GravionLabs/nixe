// @vitest-environment jsdom
import "@angular/compiler";
import { signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { BrowserTestingModule, platformBrowserTesting } from "@angular/platform-browser/testing";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

import { backend } from "../file/backend";
import { DocumentService } from "../file/document.service";
import { TabsService } from "../tabs/tabs.service";
import { SearchService } from "../index/search.service";
import { OutlineService } from "../outline/outline.service";
import { SettingsService } from "../settings/settings.service";
import { WorkspaceService } from "../workspace/workspace.service";
import { BookmarksService } from "./bookmarks.service";

describe("BookmarksService", () => {
  const vaultRoot = signal<string | null>("/v");
  const inVault = signal(false);
  const docPath = signal<string | null>("/v/dir/a.md");
  const doc = {
    path: docPath,
    content: signal("# Intro\n\ntext\n\n## Deep\n"),
    open: vi.fn(),
    pendingLine: { set: vi.fn() },
  };
  const outline = {
    headings: signal([
      { level: 1, text: "Intro", line: 1 },
      { level: 2, text: "Deep", line: 5 },
    ]),
    current: signal(1),
  };
  const search = { query: signal("tag:#x") };
  let service: BookmarksService;
  let appFile: string | null;
  let vaultFile: string | null;
  let hasFolder: boolean;
  const tabs = {
    openPreview: vi.fn().mockResolvedValue(undefined),
    openPinned: vi.fn().mockResolvedValue(undefined),
  };
  const writeApp = vi.spyOn(backend, "writeAppBookmarks");
  const writeVault = vi.spyOn(backend, "writeVaultBookmarks");

  beforeAll(() => TestBed.initTestEnvironment(BrowserTestingModule, platformBrowserTesting()));

  async function start(): Promise<void> {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        { provide: WorkspaceService, useValue: { vaultRoot } },
        { provide: SettingsService, useValue: { bookmarksInVault: inVault } },
        { provide: DocumentService, useValue: doc },
        { provide: TabsService, useValue: tabs },
        { provide: OutlineService, useValue: outline },
        { provide: SearchService, useValue: search },
      ],
    });
    service = TestBed.inject(BookmarksService);
    TestBed.tick();
    await vi.waitFor(() => expect(service.store()).not.toBeNull());
  }

  beforeEach(() => {
    vaultRoot.set("/v");
    inVault.set(false);
    docPath.set("/v/dir/a.md");
    appFile = null;
    vaultFile = null;
    hasFolder = true;
    doc.open = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(backend, "readAppBookmarks").mockImplementation(async () => appFile);
    vi.spyOn(backend, "readVaultBookmarks").mockImplementation(async () => vaultFile);
    vi.spyOn(backend, "isDir").mockImplementation(async () => hasFolder);
    writeApp.mockReset().mockImplementation(async (c) => void (appFile = c));
    writeVault.mockReset().mockImplementation(async (c) => void (vaultFile = c));
  });

  it("keeps bookmarks in the app data by default, one entry per vault", async () => {
    appFile = JSON.stringify({ "/other": { items: [{ type: "file", path: "x.md" }] } });
    await start();
    expect(service.store()).toBe("app");
    service.toggleNote();
    service.bookmarkHeading("dir/a.md", "Deep");
    await service.flush();
    expect(writeVault).not.toHaveBeenCalled();
    const stored = JSON.parse(appFile!);
    expect(stored["/other"].items).toHaveLength(1);
    expect(stored["/v"].items).toEqual([
      expect.objectContaining({ type: "file", path: "dir/a.md" }),
      expect.objectContaining({ type: "file", path: "dir/a.md", subpath: "#Deep" }),
    ]);
    expect(service.noteBookmarked()).toBe(true);
    service.toggleNote();
    expect(service.items()).toHaveLength(1);
  });

  it("starts from the Obsidian file when the app data has nothing, and does not write into the vault", async () => {
    vaultFile = JSON.stringify({ items: [{ type: "file", path: "n.md" }] });
    await start();
    expect(service.items()).toEqual([{ type: "file", path: "n.md" }]);
    service.addGroup("G");
    await service.flush();
    expect(writeVault).not.toHaveBeenCalled();
    expect(JSON.parse(appFile!)["/v"].items).toHaveLength(2);
  });

  it("reads and writes .obsidian/bookmarks.json when the setting is on, keeping unknown keys", async () => {
    inVault.set(true);
    vaultFile = JSON.stringify({
      items: [
        { type: "file", path: "n.md" },
        { type: "url", url: "u" },
      ],
      other: 1,
    });
    await start();
    expect(service.store()).toBe("vault");
    service.bookmarkSearch();
    await service.flush();
    expect(writeApp).not.toHaveBeenCalled();
    const written = JSON.parse(vaultFile!);
    expect(written.other).toBe(1);
    expect(written.items.map((i: { type: string }) => i.type)).toEqual(["file", "url", "search"]);
  });

  it("never overwrites a vault file that is damaged or cannot be read", async () => {
    inVault.set(true);
    vaultFile = "<<<<<<< conflict";
    await start();
    service.toggleNote();
    await service.flush();
    expect(writeVault).not.toHaveBeenCalled();
    expect(service.notice()).toContain("not readable");
    vi.spyOn(backend, "readVaultBookmarks").mockRejectedValue(new Error("denied"));
    await start();
    service.toggleNote();
    await service.flush();
    expect(writeVault).not.toHaveBeenCalled();
  });

  it("falls back to the app data when the vault has no .obsidian folder", async () => {
    inVault.set(true);
    hasFolder = false;
    await start();
    expect(service.store()).toBe("app");
  });

  it("bookmarks the heading at the top and the search, and ignores an empty search", async () => {
    await start();
    expect(service.bookmarkCurrentHeading()).toBe(true);
    expect(service.bookmarkSearch()).toBe(true);
    expect(service.bookmarkSearch("  ")).toBe(false);
    expect(service.items()).toEqual([
      expect.objectContaining({ path: "dir/a.md", subpath: "#Deep" }),
      expect.objectContaining({ type: "search", query: "tag:#x" }),
    ]);
  });

  it("keeps the bookmark of a renamed note", async () => {
    await start();
    service.toggleNote();
    service.renamed("dir/a.md", "dir/b.md");
    await service.flush();
    expect(service.items()).toEqual([expect.objectContaining({ path: "dir/b.md" })]);
    expect(JSON.parse(appFile!)["/v"].items[0].path).toBe("dir/b.md");
  });

  it("opens a bookmarked heading at its line and a search through the callback", async () => {
    await start();
    await service.open({ type: "file", path: "dir/a.md", subpath: "#Deep" }, vi.fn());
    expect(tabs.openPreview).toHaveBeenCalledWith("/v/dir/a.md");
    await service.open({ type: "file", path: "dir/a.md", subpath: "" }, vi.fn(), true);
    expect(tabs.openPinned).toHaveBeenCalledWith("/v/dir/a.md");
    expect(doc.pendingLine.set).toHaveBeenCalledWith(5);
    const onSearch = vi.fn();
    await service.open({ type: "search", query: "q" }, onSearch);
    expect(onSearch).toHaveBeenCalledWith("q");
  });

  it("does not write when the stores could not be read", async () => {
    vi.spyOn(backend, "readAppBookmarks").mockRejectedValue(new Error("denied"));
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        { provide: WorkspaceService, useValue: { vaultRoot } },
        { provide: SettingsService, useValue: { bookmarksInVault: inVault } },
        { provide: DocumentService, useValue: doc },
        { provide: TabsService, useValue: tabs },
        { provide: OutlineService, useValue: outline },
        { provide: SearchService, useValue: search },
      ],
    });
    const s = TestBed.inject(BookmarksService);
    TestBed.tick();
    await new Promise((r) => setTimeout(r, 10));
    s.toggleNote();
    await s.flush();
    expect(writeApp).not.toHaveBeenCalled();
  });
});

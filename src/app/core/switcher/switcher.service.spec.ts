// @vitest-environment jsdom
import "@angular/compiler";
import { signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { BrowserTestingModule, platformBrowserTesting } from "@angular/platform-browser/testing";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { backend } from "../file/backend";
import type { RootArg } from "../file/backend";
import { WorkspaceService } from "../workspace/workspace.service";
import { WorkspacesService } from "../workspace/workspaces.service";
import { SwitcherService } from "./switcher.service";

describe("SwitcherService", () => {
  const vaultFiles = signal<string[] | null>(["Alpha.md", "Beta.md", "img.png"]);
  const searchRoots = signal<RootArg[] | null>(null);
  let switcher: SwitcherService;

  beforeAll(() => {
    TestBed.initTestEnvironment(BrowserTestingModule, platformBrowserTesting());
  });

  beforeEach(() => {
    vaultFiles.set(["Alpha.md", "Beta.md", "img.png"]);
    searchRoots.set(null);
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        { provide: WorkspaceService, useValue: { vaultRoot: signal("/v"), vaultFiles } },
        { provide: WorkspacesService, useValue: { searchRoots } },
      ],
    });
    switcher = TestBed.inject(SwitcherService);
  });

  it("uses the index, including aliases", async () => {
    vi.spyOn(backend, "notes").mockResolvedValue([
      { path: "Home.md", title: "Home", aliases: ["Start"] },
    ]);
    await switcher.load();
    expect(switcher.search("start").matches[0]?.entry.path).toBe("Home.md");
  });

  it("falls back to the Markdown files when the index is unavailable", async () => {
    vi.spyOn(backend, "notes").mockRejectedValue("no index");
    await switcher.load();
    expect(switcher.search("").matches.map((m) => m.entry.path)).toEqual(["Alpha.md", "Beta.md"]);
  });

  it("lists recently opened notes first", async () => {
    vi.spyOn(backend, "notes").mockRejectedValue("no index");
    switcher.noteOpened("/v/Beta.md");
    switcher.noteOpened("/elsewhere/Alpha.md");
    switcher.noteOpened("/v/Alpha.md");
    switcher.noteOpened("/v/Beta.md");
    expect(switcher.recentNotes()).toEqual(["Beta.md", "Alpha.md"]);
    await switcher.load();
    expect(switcher.search("").matches.map((m) => m.entry.path)).toEqual(["Beta.md", "Alpha.md"]);
  });

  it("lists only the recent notes of the current vault", () => {
    const root = TestBed.inject(WorkspaceService).vaultRoot as unknown as ReturnType<
      typeof signal<string>
    >;
    switcher.noteOpened("/v/Alpha.md");
    root.set("/w");
    expect(switcher.recentNotes()).toEqual([]);
    switcher.noteOpened("/w/Gamma.md");
    expect(switcher.recentNotes()).toEqual(["Gamma.md"]);
    root.set("/v");
    expect(switcher.recentNotes()).toEqual(["Alpha.md"]);
  });

  it("finds nothing for a query that matches no note", async () => {
    vi.spyOn(backend, "notes").mockRejectedValue("no index");
    await switcher.load();
    expect(switcher.search("zzz").matches).toEqual([]);
  });

  it("caps the list at 50 and says that more notes match", async () => {
    const notes = Array.from({ length: 51 }, (_, i) => ({
      path: `n${i}.md`,
      title: `n${i}`,
      aliases: [],
    }));
    vi.spyOn(backend, "notes").mockResolvedValue(notes);
    await switcher.load();
    expect(switcher.search("").matches).toHaveLength(50);
    expect(switcher.search("").truncated).toBe(true);
    expect(switcher.search("n1").truncated).toBe(false);
  });

  describe("over a workspace (#117)", () => {
    const roots = [
      { path: "/v", name: "Notes" },
      { path: "/w", name: "My Wiki" },
    ];
    const notes = [
      { root: "Notes", rootPath: "/v", path: "Todo.md", title: "Todo", aliases: [] },
      { root: "My Wiki", rootPath: "/w", path: "Todo.md", title: "Todo", aliases: [] },
      { root: "My Wiki", rootPath: "/w", path: "Guide.md", title: "Guide", aliases: [] },
    ];

    it("lists the notes of all roots, each with its root", async () => {
      searchRoots.set(roots);
      const spy = vi.spyOn(backend, "workspaceNotes").mockResolvedValue(notes);
      await switcher.load();
      expect(spy).toHaveBeenCalledWith(roots);
      expect(switcher.search("todo").matches.map((m) => [m.entry.root, m.entry.path])).toEqual([
        ["Notes", "Todo.md"],
        ["My Wiki", "Todo.md"],
      ]);
    });

    it("narrows the list with root:", async () => {
      searchRoots.set(roots);
      vi.spyOn(backend, "workspaceNotes").mockResolvedValue(notes);
      await switcher.load();
      expect(switcher.search('root:"my wiki" todo').matches.map((m) => m.entry.rootPath)).toEqual([
        "/w",
      ]);
      expect(switcher.search("root:notes").matches.map((m) => m.entry.path)).toEqual(["Todo.md"]);
      expect(switcher.search("root:nothing").matches).toEqual([]);
    });

    it("uses the notes of the open folder when there is no workspace", async () => {
      const spy = vi.spyOn(backend, "workspaceNotes");
      spy.mockClear();
      vi.spyOn(backend, "notes").mockResolvedValue([{ path: "A.md", title: "A", aliases: [] }]);
      await switcher.load();
      expect(spy).not.toHaveBeenCalled();
      expect(switcher.search("").matches[0].entry.root).toBeUndefined();
    });
  });
});

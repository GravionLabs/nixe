// @vitest-environment jsdom
/* oxlint-disable typescript/no-explicit-any -- the spec calls protected members of the component under test through `as any` */
import "@angular/compiler";
import { ApplicationRef, ElementRef, signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { BrowserTestingModule, platformBrowserTesting } from "@angular/platform-browser/testing";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ ask: vi.fn(), open: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ revealItemInDir: vi.fn() }));

import { BookmarksService } from "../../core/bookmarks/bookmarks.service";
import { DocumentService } from "../../core/file/document.service";
import { GitService } from "../../core/git/git.service";
import { ShortcutService } from "../../core/commands/shortcut.service";
import { SettingsService } from "../../core/settings/settings.service";
import { ChangesService } from "../../core/git/changes.service";
import { TabsService } from "../../core/tabs/tabs.service";
import { TREE_SORTS } from "../../core/workspace/tree-model";
import { VaultOpsService } from "../../core/workspace/vault-ops.service";
import type { TreeNode } from "../../core/workspace/workspace.service";
import { WorkspaceService } from "../../core/workspace/workspace.service";
import { SidebarComponent } from "./sidebar.component";

function node(name: string, kind: "dir" | "file", depth = 0, expanded = false): TreeNode {
  const path = `/v/${name}`;
  return {
    name,
    dirPath: kind === "dir" ? path : null,
    filePath: kind === "file" ? path : null,
    hasOrder: false,
    modified: 0,
    depth,
    expanded: signal(expanded),
    children: signal(null),
  };
}

function key(name: string, init: KeyboardEventInit = {}): KeyboardEvent {
  return new KeyboardEvent("keydown", { key: name, cancelable: true, ...init });
}

const KEYS: Record<string, string[]> = {
  "new-note": ["Ctrl", "N"],
  "new-folder": ["Ctrl", "Shift", "N"],
  "toggle-editor": ["Ctrl", "E"],
};

describe("SidebarComponent tree", () => {
  const rows = [
    node("alpha", "dir", 0, true),
    node("a.md", "file", 1),
    node("beta.md", "file", 0),
    node("box", "dir", 0),
  ];
  const workspace = {
    visible: signal(rows),
    filteredRows: signal<TreeNode[]>([]),
    treeFilter: signal(""),
    setTreeFilter: vi.fn(async (text: string) => workspace.treeFilter.set(text)),
    root: signal("/v"),
    vaultRoot: signal<string | null>("/v"),
    toggle: vi.fn(),
    revealRequest: signal(0),
    sort: signal(TREE_SORTS[0]),
    setSort: vi.fn(),
  };
  const gitStatus = signal<{
    changes: { path: string; kind: string; untracked?: boolean }[];
  } | null>(null);
  const treeGitStatus = signal(true);
  const ops = { trash: vi.fn(), move: vi.fn() };
  const tabs = { openInNewTab: vi.fn(), openPreview: vi.fn(), openPinned: vi.fn() };
  const doc = { path: signal<string | null>(null), open: vi.fn() };
  let sidebar: SidebarComponent & Record<string, any>;
  let host: HTMLElement;

  beforeAll(() => {
    TestBed.initTestEnvironment(BrowserTestingModule, platformBrowserTesting());
  });

  beforeEach(() => {
    vi.clearAllMocks();
    workspace.treeFilter.set("");
    gitStatus.set(null);
    treeGitStatus.set(true);
    host = document.createElement("div");
    host.innerHTML = rows
      .map((r) => `<div class="row" data-path="${r.dirPath ?? r.filePath}" tabindex="-1"></div>`)
      .join("");
    document.body.append(host);
    ops.trash.mockResolvedValue(undefined);
    ops.move.mockResolvedValue([]);
    workspace.toggle.mockResolvedValue(undefined);
    doc.open.mockResolvedValue(undefined);
    tabs.openPreview.mockResolvedValue(undefined);
    tabs.openPinned.mockResolvedValue(undefined);
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        { provide: WorkspaceService, useValue: workspace },
        { provide: DocumentService, useValue: doc },
        { provide: ChangesService, useValue: { unseenPaths: signal(new Set()) } },
        { provide: VaultOpsService, useValue: ops },
        { provide: TabsService, useValue: tabs },
        { provide: BookmarksService, useValue: { relative: () => null, items: () => [] } },
        { provide: GitService, useValue: { status: gitStatus } },
        { provide: SettingsService, useValue: { treeGitStatus } },
        {
          provide: ShortcutService,
          useValue: {
            keys: (id: string) => KEYS[id] ?? [],
            display: (id: string) => (KEYS[id] ?? []).join("+"),
          },
        },
        { provide: ElementRef, useValue: new ElementRef(host) },
      ],
    });
    sidebar = TestBed.runInInjectionContext(() => new SidebarComponent()) as SidebarComponent &
      Record<string, any>;
  });

  const focusedPath = () => (document.activeElement as HTMLElement | null)?.dataset["path"];

  it("has one tab stop: the first row until another has the focus", () => {
    expect(rows.map((r) => sidebar.rowTabindex(r))).toEqual([0, -1, -1, -1]);
    sidebar.onKeydown(rows[0], key("ArrowDown"));
    expect(rows.map((r) => sidebar.rowTabindex(r))).toEqual([-1, 0, -1, -1]);
  });

  it("moves the focus with the arrows, Home and End", () => {
    sidebar.onKeydown(rows[0], key("ArrowDown"));
    expect(focusedPath()).toBe("/v/a.md");
    sidebar.onKeydown(rows[1], key("End"));
    expect(focusedPath()).toBe("/v/box");
    sidebar.onKeydown(rows[3], key("ArrowUp"));
    expect(focusedPath()).toBe("/v/beta.md");
    sidebar.onKeydown(rows[2], key("Home"));
    expect(focusedPath()).toBe("/v/alpha");
  });

  it("goes from a note to its folder with left, and collapses or expands a folder", () => {
    sidebar.onKeydown(rows[1], key("ArrowLeft"));
    expect(focusedPath()).toBe("/v/alpha");
    sidebar.onKeydown(rows[0], key("ArrowLeft"));
    expect(workspace.toggle).toHaveBeenCalledWith(rows[0], false);
    sidebar.onKeydown(rows[0], key("ArrowRight"));
    expect(focusedPath()).toBe("/v/a.md");
    sidebar.onKeydown(rows[3], key("ArrowRight"));
    expect(workspace.toggle).toHaveBeenCalledWith(rows[3], true);
  });

  it("jumps to the next row that starts with the typed letter", () => {
    sidebar.onKeydown(rows[0], key("b"));
    expect(focusedPath()).toBe("/v/beta.md");
    sidebar.onKeydown(rows[2], key("b", { ctrlKey: true }));
    expect(focusedPath()).toBe("/v/beta.md");
  });

  it("a double click on a note keeps it in a tab of its own, a folder or a modifier does not", async () => {
    await sidebar.pin(rows[1], new MouseEvent("dblclick"));
    expect(tabs.openPinned).toHaveBeenCalledWith("/v/a.md");
    await sidebar.pin(rows[1], new MouseEvent("dblclick", { shiftKey: true }));
    await sidebar.pin(rows[3], new MouseEvent("dblclick"));
    expect(tabs.openPinned).toHaveBeenCalledTimes(1);
  });

  it("selects several rows with Ctrl and Shift and does not open them", async () => {
    await sidebar.select(rows[1], new MouseEvent("click"));
    expect(tabs.openPreview).toHaveBeenCalledWith("/v/a.md");
    await sidebar.select(rows[2], new MouseEvent("click", { ctrlKey: true }));
    expect([...sidebar.selection()]).toEqual(["/v/a.md", "/v/beta.md"]);
    await sidebar.select(rows[3], new MouseEvent("click", { shiftKey: true }));
    expect([...sidebar.selection()].sort()).toEqual(["/v/beta.md", "/v/box"]);
    expect(tabs.openPreview).toHaveBeenCalledTimes(1);
  });

  it("deletes the selection, but only the row when it is not selected", async () => {
    sidebar.selection.set(new Set(["/v/a.md", "/v/beta.md"]));
    sidebar.onKeydown(rows[2], key("Delete"));
    await vi.waitFor(() => expect(ops.trash).toHaveBeenCalledTimes(2));
    expect(ops.trash.mock.calls.map((c) => c[0])).toEqual(["/v/a.md", "/v/beta.md"]);
    ops.trash.mockClear();
    sidebar.onKeydown(rows[3], key("Delete"));
    await vi.waitFor(() => expect(ops.trash).toHaveBeenCalledWith("/v/box"));
    expect(ops.trash).toHaveBeenCalledTimes(1);
  });

  it("moves the dragged selection onto a folder, and refuses a note as the target", async () => {
    sidebar.selection.set(new Set(["/v/a.md", "/v/beta.md"]));
    const start = { dataTransfer: { setData: vi.fn(), effectAllowed: "" } } as unknown as DragEvent;
    sidebar.dragStart(start, rows[2]);
    const over = (_target: TreeNode) =>
      ({
        stopPropagation: vi.fn(),
        preventDefault: vi.fn(),
        dataTransfer: { dropEffect: "" },
      }) as unknown as DragEvent;
    const noteOver = over(rows[1]);
    sidebar.dragOver(noteOver, rows[1]);
    expect(noteOver.preventDefault).not.toHaveBeenCalled();
    const folderOver = over(rows[3]);
    sidebar.dragOver(folderOver, rows[3]);
    expect(folderOver.preventDefault).toHaveBeenCalled();
    expect(sidebar.dropTarget()).toBe("/v/box");
    await sidebar.drop(over(rows[3]), rows[3]);
    expect(ops.move).toHaveBeenCalledWith(["/v/a.md", "/v/beta.md"], "/v/box");
  });

  it("forgets a cancelled drag", () => {
    sidebar.dragStart({ dataTransfer: { setData: vi.fn() } } as unknown as DragEvent, rows[1]);
    sidebar.dragEnd();
    const over = { stopPropagation: vi.fn(), preventDefault: vi.fn() } as unknown as DragEvent;
    sidebar.dragOver(over, rows[3]);
    expect(over.preventDefault).not.toHaveBeenCalled();
  });

  it("reports a refused move", async () => {
    const errors: string[] = [];
    sidebar.failed.subscribe((e: string) => errors.push(e));
    ops.move.mockRejectedValue(new Error("Not moved: a.md already exists in box."));
    sidebar.dragStart({ dataTransfer: { setData: vi.fn() } } as unknown as DragEvent, rows[1]);
    await sidebar.drop(
      { stopPropagation: vi.fn(), preventDefault: vi.fn() } as unknown as DragEvent,
      rows[3],
    );
    expect(errors[0]).toContain("already exists");
  });

  it("decorates changed notes and their folders, and not when the setting is off", () => {
    gitStatus.set({
      changes: [
        { path: "alpha/a.md", kind: "modified" },
        { path: "beta.md", kind: "added", untracked: true },
      ],
    });
    expect(sidebar.decoration().files.get("/v/alpha/a.md")).toBe("M");
    expect(sidebar.decoration().files.get("/v/beta.md")).toBe("U");
    expect(sidebar.decoration().folders.has("/v/alpha")).toBe(true);
    treeGitStatus.set(false);
    expect(sidebar.decoration().files.size).toBe(0);
    treeGitStatus.set(true);
    gitStatus.set(null);
    expect(sidebar.decoration().files.size).toBe(0);
  });

  it("shows the filtered rows and Escape clears the field", () => {
    workspace.filteredRows.set([rows[2]]);
    sidebar.setFilter("bet");
    expect(workspace.setTreeFilter).toHaveBeenCalledWith("bet");
    expect(sidebar.rows()).toEqual([rows[2]]);
    expect(sidebar.isOpen(rows[3])).toBe(true);
    const escape = key("Escape");
    sidebar.onFilterKeydown(escape);
    expect(escape.defaultPrevented).toBe(true);
    expect(workspace.setTreeFilter).toHaveBeenLastCalledWith("");
    expect(sidebar.rows()).toEqual(rows);
  });

  it("hides the filter field by default and the button shows and hides it", () => {
    expect(sidebar.filterShown()).toBe(false);
    sidebar.toggleFilter();
    expect(sidebar.filterShown()).toBe(true);
    sidebar.setFilter("bet");
    sidebar.toggleFilter();
    expect(sidebar.filterShown()).toBe(false);
    expect(workspace.setTreeFilter).toHaveBeenLastCalledWith("");
  });

  it("keeps the field visible while a filter text is set", () => {
    workspace.treeFilter.set("bet");
    expect(sidebar.filterShown()).toBe(true);
    expect(sidebar.filterOpen()).toBe(false);
  });

  it("Escape hides the field, clears the filter and focuses the tree", () => {
    sidebar.toggleFilter();
    sidebar.setFilter("bet");
    const escape = key("Escape");
    // While filtered only the match is rendered; the other rows come back after the clear.
    const hidden = [...host.querySelectorAll(".row")].filter(
      (r) => (r as HTMLElement).dataset["path"] !== "/v/beta.md",
    );
    hidden.forEach((r) => r.remove());
    sidebar.onFilterKeydown(escape);
    expect(sidebar.filterShown()).toBe(false);
    expect(workspace.setTreeFilter).toHaveBeenLastCalledWith("");
    host.innerHTML = rows
      .map((r) => `<div class="row" data-path="${r.dirPath ?? r.filePath}" tabindex="-1"></div>`)
      .join("");
    TestBed.inject(ApplicationRef).tick();
    expect(focusedPath()).toBe("/v/alpha");
  });

  it("flashes the active row for 2 s after a reveal request, not without one", () => {
    vi.useFakeTimers();
    try {
      host.innerHTML = '<div class="row active" data-path="/v/a.md"></div>';
      TestBed.runInInjectionContext(() => TestBed.flushEffects?.());
      workspace.revealRequest.set(1);
      TestBed.flushEffects?.();
      vi.advanceTimersByTime(1);
      expect(sidebar.flashed()).toBe("/v/a.md");
      vi.advanceTimersByTime(2000);
      expect(sidebar.flashed()).toBeNull();
    } finally {
      workspace.revealRequest.set(0);
      vi.useRealTimers();
    }
  });
  describe("menus", () => {
    const labels = (items: { label?: string }[]) => items.map((i) => i.label);

    it("shows the shortcut of a command entry at its right", () => {
      sidebar.menu.set({ node: rows[1] });
      const items = sidebar.menuItems() as { label?: string; badge?: string }[];
      expect(items.find((i) => i.label === "New note")?.badge).toBe("Ctrl+N");
      expect(items.find((i) => i.label === "New folder")?.badge).toBe("Ctrl+Shift+N");
    });

    it("offers the folder and file entries of the node the menu opened on", () => {
      sidebar.menu.set({ node: rows[1] });
      expect(labels(sidebar.menuItems())).toEqual([
        "New note",
        "New folder",
        "Bookmark",
        "Rename",
        "Delete",
        sidebar.revealLabel,
      ]);
      sidebar.menu.set({ node: rows[0] });
      expect(labels(sidebar.menuItems())).toEqual([
        "New note",
        "New folder",
        "Rename",
        "Delete",
        sidebar.revealLabel,
      ]);
    });

    it("offers only the creating and revealing entries on the empty area", () => {
      sidebar.menu.set({ node: null });
      expect(labels(sidebar.menuItems())).toEqual(["New note", "New folder", sidebar.revealLabel]);
    });

    it("deletes the node of the menu even after the menu state is cleared", () => {
      sidebar.menu.set({ node: rows[2] });
      const del = sidebar.menuItems().find((i: { label?: string }) => i.label === "Delete");
      sidebar.menu.set(null);
      del.command({});
      expect(ops.trash).toHaveBeenCalled();
    });

    it("marks the current sort order and sets another one", () => {
      const items = sidebar.sortItems();
      expect(items.filter((i: { label: string }) => i.label.startsWith("✓ "))).toHaveLength(1);
      const other = items.find((i: { label: string }) => !i.label.startsWith("✓ "));
      other.command({});
      expect(workspace.setSort).toHaveBeenCalled();
    });
  });
});

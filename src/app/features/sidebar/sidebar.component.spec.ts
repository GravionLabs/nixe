// @vitest-environment jsdom
import "@angular/compiler";
import { ElementRef, signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { BrowserTestingModule, platformBrowserTesting } from "@angular/platform-browser/testing";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ ask: vi.fn(), open: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ revealItemInDir: vi.fn() }));

import { BookmarksService } from "../../core/bookmarks/bookmarks.service";
import { DocumentService } from "../../core/file/document.service";
import { ChangesService } from "../../core/git/changes.service";
import { TabsService } from "../../core/tabs/tabs.service";
import { VaultOpsService } from "../../core/workspace/vault-ops.service";
import { TreeNode, WorkspaceService } from "../../core/workspace/workspace.service";
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

describe("SidebarComponent tree", () => {
  const rows = [node("alpha", "dir", 0, true), node("a.md", "file", 1), node("beta.md", "file", 0), node("box", "dir", 0)];
  const workspace = { visible: signal(rows), root: signal("/v"), toggle: vi.fn(), revealRequest: signal(0) };
  const ops = { trash: vi.fn(), move: vi.fn() };
  const tabs = { openInNewTab: vi.fn() };
  const doc = { path: signal<string | null>(null), open: vi.fn() };
  let sidebar: SidebarComponent & Record<string, any>;
  let host: HTMLElement;

  beforeAll(() => {
    TestBed.initTestEnvironment(BrowserTestingModule, platformBrowserTesting());
  });

  beforeEach(() => {
    vi.clearAllMocks();
    host = document.createElement("div");
    host.innerHTML = rows.map((r) => `<div class="row" data-path="${r.dirPath ?? r.filePath}" tabindex="-1"></div>`).join("");
    document.body.append(host);
    ops.trash.mockResolvedValue(undefined);
    ops.move.mockResolvedValue([]);
    workspace.toggle.mockResolvedValue(undefined);
    doc.open.mockResolvedValue(undefined);
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        { provide: WorkspaceService, useValue: workspace },
        { provide: DocumentService, useValue: doc },
        { provide: ChangesService, useValue: { unseenPaths: signal(new Set()) } },
        { provide: VaultOpsService, useValue: ops },
        { provide: TabsService, useValue: tabs },
        { provide: BookmarksService, useValue: {} },
        { provide: ElementRef, useValue: new ElementRef(host) },
      ],
    });
    sidebar = TestBed.runInInjectionContext(() => new SidebarComponent()) as SidebarComponent & Record<string, any>;
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

  it("selects several rows with Ctrl and Shift and does not open them", async () => {
    await sidebar.select(rows[1], new MouseEvent("click"));
    expect(doc.open).toHaveBeenCalledWith("/v/a.md");
    await sidebar.select(rows[2], new MouseEvent("click", { ctrlKey: true }));
    expect([...sidebar.selection()]).toEqual(["/v/a.md", "/v/beta.md"]);
    await sidebar.select(rows[3], new MouseEvent("click", { shiftKey: true }));
    expect([...sidebar.selection()].sort()).toEqual(["/v/beta.md", "/v/box"]);
    expect(doc.open).toHaveBeenCalledTimes(1);
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
    const over = (target: TreeNode) =>
      ({ stopPropagation: vi.fn(), preventDefault: vi.fn(), dataTransfer: { dropEffect: "" } }) as unknown as DragEvent;
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
    sidebar.error.subscribe((e: string) => errors.push(e));
    ops.move.mockRejectedValue(new Error("Not moved: a.md already exists in box."));
    sidebar.dragStart({ dataTransfer: { setData: vi.fn() } } as unknown as DragEvent, rows[1]);
    await sidebar.drop({ stopPropagation: vi.fn(), preventDefault: vi.fn() } as unknown as DragEvent, rows[3]);
    expect(errors[0]).toContain("already exists");
  });
});

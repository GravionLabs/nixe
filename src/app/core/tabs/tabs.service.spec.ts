// @vitest-environment jsdom
import "@angular/compiler";
import { readFileSync } from "node:fs";
import { Component, inject } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { NgComponentOutlet } from "@angular/common";
import { BrowserTestingModule, platformBrowserTesting } from "@angular/platform-browser/testing";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

import { EditorService } from "../editor/editor.service";
import { DocumentService } from "../file/document.service";
import { SettingsService } from "../settings/settings.service";
import { ACTIVE_TAB_PROVIDERS, TabsService } from "./tabs.service";

const FILES: Record<string, string> = { "/v/a.md": "# A", "/v/b.md": "# B", "/v/c.md": "# C" };

describe("TabsService", () => {
  let tabs: TabsService;

  beforeAll(() => {
    TestBed.initTestEnvironment(BrowserTestingModule, platformBrowserTesting());
  });

  beforeEach(() => {
    // The settings read the color scheme.
    window.matchMedia ??= (() => ({ matches: false, addEventListener: vi.fn() })) as never;
    invoke.mockReset();
    invoke.mockImplementation(async (cmd: string, args: { path: string }) => {
      if (cmd === "read_text_file") {
        if (!(args.path in FILES)) throw new Error("missing");
        return FILES[args.path];
      }
      if (cmd === "find_wiki_root") return "/v";
      if (cmd === "is_utf8_file") return true;
      if (cmd === "download_epub") {
        if (!String(args.url).startsWith("https://")) throw "only https URLs are downloaded";
        return "/data/books/sample-1.epub";
      }
      if (cmd === "read_epub") {
        if (!/sample(-1)?\.epub$/.test(args.path)) throw "outside the open roots and the vault";
        return [...readFileSync("fixtures/books/sample.epub")];
      }
      return undefined;
    });
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ providers: [...ACTIVE_TAB_PROVIDERS] });
    tabs = TestBed.inject(TabsService);
  });

  const shown = () => tabs.activeTab().doc.path();

  it("starts with one empty tab", () => {
    expect(tabs.panes().length).toBe(1);
    expect(tabs.panes()[0].tabs.length).toBe(1);
    expect(shown()).toBeNull();
    expect(tabs.showWorkspace()).toBe(false);
  });

  it("opens a note in a new tab and keeps the other tab's note", async () => {
    await tabs.activeTab().doc.open("/v/a.md");
    await tabs.openInNewTab("/v/b.md");
    expect(tabs.panes()[0].tabs.map((t) => t.doc.path())).toEqual(["/v/a.md", "/v/b.md"]);
    expect(shown()).toBe("/v/b.md");
  });

  it("drops the new tab again when the note cannot be opened", async () => {
    await tabs.activeTab().doc.open("/v/a.md");
    await expect(tabs.openInNewTab("/v/missing.md")).rejects.toThrow("missing");
    expect(tabs.panes()[0].tabs.length).toBe(1);
    expect(shown()).toBe("/v/a.md");
  });

  it("gives every tab its own history and mode", async () => {
    const first = tabs.activeTab();
    await first.doc.open("/v/a.md");
    await first.doc.open("/v/b.md");
    await tabs.openInNewTab("/v/c.md");
    const second = tabs.activeTab();
    second.editor.editing.set(true);
    expect(first.doc.canGoBack()).toBe(true);
    expect(second.doc.canGoBack()).toBe(false);
    expect(first.editor.editing()).toBe(false);
    await first.doc.back();
    expect(first.doc.path()).toBe("/v/a.md");
    expect(second.doc.path()).toBe("/v/c.md");
  });

  it("makes the app-wide services follow the shown tab", async () => {
    const doc = TestBed.inject(DocumentService);
    const editor = TestBed.inject(EditorService);
    await doc.open("/v/a.md");
    await tabs.openInNewTab("/v/b.md");
    expect(doc.path()).toBe("/v/b.md");
    editor.editing.set(true);
    expect(tabs.activeTab().editor.editing()).toBe(true);
    tabs.activate(tabs.focusedPane().id, tabs.panes()[0].tabs[0].id);
    expect(doc.path()).toBe("/v/a.md");
    expect(editor.editing()).toBe(false);
    expect(doc.canGoForward()).toBe(false);
  });

  it("closes the shown tab and shows its neighbour", async () => {
    await tabs.activeTab().doc.open("/v/a.md");
    await tabs.openInNewTab("/v/b.md");
    await tabs.openInNewTab("/v/c.md");
    expect(tabs.closeTab()).toBe(true);
    expect(shown()).toBe("/v/b.md");
    const pane = tabs.focusedPane();
    expect(tabs.closeTab(pane.id, pane.tabs[0].id)).toBe(true);
    expect(shown()).toBe("/v/b.md");
    expect(tabs.panes()[0].tabs.length).toBe(1);
  });

  it("leaves an empty tab when the last one closes, and reports there is nothing left to close", async () => {
    await tabs.activeTab().doc.open("/v/a.md");
    expect(tabs.closeTab()).toBe(true);
    expect(shown()).toBeNull();
    expect(tabs.closeTab()).toBe(false);
  });

  it("cycles through the tabs and wraps around", async () => {
    await tabs.activeTab().doc.open("/v/a.md");
    await tabs.openInNewTab("/v/b.md");
    await tabs.openInNewTab("/v/c.md");
    tabs.cycle(1);
    expect(shown()).toBe("/v/a.md");
    tabs.cycle(-1);
    expect(shown()).toBe("/v/c.md");
    tabs.cycle(-1);
    expect(shown()).toBe("/v/b.md");
  });

  it("keeps the scroll position of a tab it leaves", async () => {
    const first = tabs.activeTab();
    await first.doc.open("/v/a.md");
    first.viewer = { topLine: () => 42, openFind: vi.fn() };
    tabs.newTab();
    expect(first.scrollLine).toBe(42);
    expect(first.doc.pendingLine()).toBe(42);
  });

  it("writes typed text before a split copies the note", async () => {
    await tabs.activeTab().doc.open("/v/a.md");
    const flush = vi.fn().mockResolvedValue(undefined);
    tabs.activeTab().editor.handle = { flush, topLine: () => 1 } as never;
    await tabs.splitRight();
    expect(flush).toHaveBeenCalled();
  });

  describe("split", () => {
    it("shows a copy of the tab to the right and focuses it", async () => {
      const left = tabs.activeTab();
      await left.doc.open("/v/a.md");
      await left.doc.open("/v/b.md");
      left.editor.editing.set(true);
      await tabs.splitRight();
      expect(tabs.split()).toBe(true);
      expect(tabs.panes().map((p) => p.tabs.map((t) => t.doc.path()))).toEqual([
        ["/v/b.md"],
        ["/v/b.md"],
      ]);
      const right = tabs.activeTab();
      expect(right).not.toBe(left);
      expect(right.editor.editing()).toBe(true);
      expect(right.doc.canGoBack()).toBe(true);
    });

    it("follows the focus with the app-wide services", async () => {
      const doc = TestBed.inject(DocumentService);
      await doc.open("/v/a.md");
      await tabs.splitRight();
      await doc.open("/v/b.md");
      expect(tabs.panes()[0].tabs[0].doc.path()).toBe("/v/a.md");
      tabs.focusPane(tabs.panes()[0].id);
      expect(doc.path()).toBe("/v/a.md");
      tabs.focusNextPane();
      expect(doc.path()).toBe("/v/b.md");
    });

    it("watches the note of the focused pane", async () => {
      await tabs.activeTab().doc.open("/v/a.md");
      await tabs.splitRight();
      await tabs.activeTab().doc.open("/v/b.md");
      invoke.mockClear();
      tabs.focusPane(tabs.panes()[0].id);
      expect(invoke).toHaveBeenCalledWith("watch_file", { path: "/v/a.md" });
    });

    it("closes the right pane with its last tab", async () => {
      await tabs.activeTab().doc.open("/v/a.md");
      await tabs.splitRight();
      expect(tabs.closeTab()).toBe(true);
      expect(tabs.split()).toBe(false);
      expect(shown()).toBe("/v/a.md");
    });

    it("merges the panes again", async () => {
      await tabs.activeTab().doc.open("/v/a.md");
      await tabs.splitRight();
      tabs.unsplit();
      expect(tabs.split()).toBe(false);
      expect(tabs.panes()[0].tabs.length).toBe(2);
    });

    it("keeps the divider inside its limits", () => {
      tabs.setRatio(0.01);
      expect(tabs.ratio()).toBe(0.15);
      tabs.setRatio(0.99);
      expect(tabs.ratio()).toBe(0.85);
      tabs.setRatio(Number.NaN);
      expect(tabs.ratio()).toBe(0.5);
    });
  });

  describe("the same note in two panes", () => {
    it("shows typing of one pane in the other", async () => {
      await tabs.activeTab().doc.open("/v/a.md");
      await tabs.splitRight();
      const [left, right] = tabs.panes().map((p) => p.tabs[0]);
      const remote = vi.fn();
      right.doc.remoteHook = remote;
      left.doc.typed("/v/a.md", "# A typed");
      expect(right.doc.content()).toBe("# A typed");
      expect(remote).toHaveBeenCalledWith("# A typed", false);
      expect(left.doc.content()).toBe("# A");
    });

    it("tells the other pane that a save is its own write", async () => {
      await tabs.activeTab().doc.open("/v/a.md");
      await tabs.splitRight();
      const [left, right] = tabs.panes().map((p) => p.tabs[0]);
      const remote = vi.fn();
      right.doc.remoteHook = remote;
      await left.doc.write("/v/a.md", "# A saved");
      expect(right.doc.content()).toBe("# A saved");
      expect(remote).toHaveBeenCalledWith("# A saved", true);
    });

    it("does not touch a pane that shows another note", async () => {
      await tabs.activeTab().doc.open("/v/a.md");
      await tabs.splitRight();
      const [left, right] = tabs.panes().map((p) => p.tabs[0]);
      await right.doc.open("/v/b.md");
      left.doc.typed("/v/a.md", "changed");
      expect(right.doc.content()).toBe("# B");
    });

    it("gives an external change to every tab that shows the note", async () => {
      await tabs.activeTab().doc.open("/v/a.md");
      await tabs.splitRight();
      FILES["/v/a.md"] = "# A on disk";
      try {
        await tabs.onExternalChange("/v/a.md");
        expect(tabs.panes().map((p) => p.tabs[0].doc.content())).toEqual([
          "# A on disk",
          "# A on disk",
        ]);
      } finally {
        FILES["/v/a.md"] = "# A";
      }
    });
  });

  describe("missing file", () => {
    it("is tracked per tab and cleared when the file returns", async () => {
      await tabs.activeTab().doc.open("/v/a.md");
      await tabs.splitRight();
      const [left, right] = tabs.panes().map((p) => p.tabs[0]);
      await right.doc.open("/v/b.md");
      const read = FILES["/v/a.md"];
      delete FILES["/v/a.md"];
      invoke.mockImplementation(async (cmd: string, args: { path: string }) => {
        if (cmd === "path_exists") return args.path in FILES;
        if (cmd === "read_text_file") {
          if (!(args.path in FILES)) throw new Error("missing");
          return FILES[args.path];
        }
        return undefined;
      });
      try {
        await tabs.onExternalChange("/v/a.md");
        expect(left.doc.missing()).toBe(true);
        expect(right.doc.missing()).toBe(false);
      } finally {
        FILES["/v/a.md"] = read;
      }
      await tabs.onExternalChange("/v/a.md");
      expect(left.doc.missing()).toBe(false);
    });
  });

  describe("missing file on activation", () => {
    it("marks and clears the state of a tab that was not watched", async () => {
      const first = tabs.activeTab();
      await first.doc.open("/v/a.md");
      tabs.newTab();
      await tabs.activeTab().doc.open("/v/b.md");
      let exists = false;
      invoke.mockImplementation(async (cmd: string) =>
        cmd === "path_exists" ? exists : undefined,
      );
      const pane = tabs.panes()[0];
      tabs.activate(pane.id, pane.tabs[0].id);
      await vi.waitFor(() => expect(first.doc.missing()).toBe(true));
      exists = true;
      tabs.activate(pane.id, pane.tabs[1].id);
      tabs.activate(pane.id, pane.tabs[0].id);
      await vi.waitFor(() => expect(first.doc.missing()).toBe(false));
    });
  });

  describe("restoring", () => {
    async function laidOut() {
      const first = tabs.activeTab();
      await first.doc.open("/v/a.md");
      await first.doc.open("/v/b.md");
      await tabs.openInNewTab("/v/c.md");
      tabs.activeTab().editor.editing.set(true);
      await tabs.splitRight();
      tabs.setRatio(0.3);
      return tabs.snapshot();
    }

    it("describes the tabs, the split and the divider", async () => {
      const layout = await laidOut();
      expect(layout.panes.length).toBe(2);
      expect(layout.panes[0].tabs.map((t) => t.path)).toEqual(["/v/b.md", "/v/c.md"]);
      expect(layout.panes[0].tabs[0]).toMatchObject({
        history: [
          { path: "/v/a.md", line: null, anchor: null },
          { path: "/v/b.md", line: null, anchor: null },
        ],
        index: 1,
        editing: false,
      });
      expect(layout.panes[0].tabs[1].editing).toBe(true);
      expect(layout.focused).toBe(1);
      expect(layout.ratio).toBe(0.3);
    });

    it("brings back tabs, history, mode, split and focus", async () => {
      const layout = await laidOut();
      TestBed.resetTestingModule();
      TestBed.configureTestingModule({ providers: [...ACTIVE_TAB_PROVIDERS] });
      tabs = TestBed.inject(TabsService);
      expect(await tabs.restore(layout)).toBe(true);
      expect(tabs.split()).toBe(true);
      expect(tabs.ratio()).toBe(0.3);
      expect(tabs.focusedPane().id).toBe(tabs.panes()[1].id);
      const [left, right] = tabs.panes();
      expect(left.tabs.map((t) => t.doc.path())).toEqual(["/v/b.md", "/v/c.md"]);
      expect(left.tabs[0].doc.canGoBack()).toBe(true);
      expect(left.tabs[1].editor.editing()).toBe(true);
      expect(right.tabs[0].doc.path()).toBe("/v/c.md");
      expect(right.tabs[0].editor.editing()).toBe(true);
    });

    it("leaves out notes that are gone", async () => {
      const layout = await laidOut();
      layout.panes[0].tabs[0].path = "/v/gone.md";
      TestBed.resetTestingModule();
      TestBed.configureTestingModule({ providers: [...ACTIVE_TAB_PROVIDERS] });
      tabs = TestBed.inject(TabsService);
      expect(await tabs.restore(layout)).toBe(true);
      expect(tabs.panes()[0].tabs.map((t) => t.doc.path())).toEqual(["/v/c.md"]);
    });

    it("does not apply a layout without a readable note", async () => {
      const layout = await laidOut();
      for (const pane of layout.panes) for (const tab of pane.tabs) tab.path = "/v/gone.md";
      TestBed.resetTestingModule();
      TestBed.configureTestingModule({ providers: [...ACTIVE_TAB_PROVIDERS] });
      tabs = TestBed.inject(TabsService);
      expect(await tabs.restore(layout)).toBe(false);
      expect(tabs.panes().length).toBe(1);
    });
  });

  describe("tabs that are not a note", () => {
    it("opens a view as a tab of its own", async () => {
      await TestBed.inject(DocumentService).open("/v/a.md");
      const tab = tabs.openView("settings");
      expect(tabs.panes()[0].tabs.length).toBe(2);
      expect(tabs.activeTab()).toBe(tab);
      expect(tab.view()).toBe("settings");
      expect(tab.doc.path()).toBeNull();
      expect(tab.doc.historyState().history).toEqual([]);
    });

    it("shows the workspace for a view alone", () => {
      tabs.openView("health");
      expect(tabs.showWorkspace()).toBe(true);
    });

    it("focuses the view that is open instead of opening a second one", async () => {
      const first = tabs.openView("settings");
      await tabs.openInNewTab("/v/a.md");
      expect(tabs.openView("settings")).toBe(first);
      expect(tabs.activeTab()).toBe(first);
      expect(tabs.panes()[0].tabs.filter((t) => t.view() === "settings").length).toBe(1);
      tabs.openView("health");
      expect(tabs.panes()[0].tabs.map((t) => t.view())).toEqual([null, "settings", null, "health"]);
    });

    it("finds the view in the other pane", async () => {
      await tabs.openInNewTab("/v/a.md");
      await tabs.splitRight();
      const [left, right] = tabs.panes();
      const view = tabs.openView("settings");
      expect(tabs.panes()[1].tabs).toContain(view);
      tabs.activate(left.id, left.tabs[0].id);
      expect(tabs.openView("settings")).toBe(view);
      expect(tabs.focusedPane().id).toBe(right.id);
    });

    it("does not store a compare view: the tab comes back empty", async () => {
      await TestBed.inject(DocumentService).open("/v/a.md");
      const tab = tabs.newTab();
      tab.compare.set({
        path: "a.md",
        title: "a",
        oldLabel: "Last sync",
        newLabel: "Now",
        oldText: "x",
        newText: "y",
      });
      tab.view.set("compare");
      expect(tabs.showWorkspace()).toBe(true);
      const layout = tabs.snapshot();
      expect(layout.panes[0].tabs[1]).toMatchObject({ view: null, path: null });
      TestBed.resetTestingModule();
      TestBed.configureTestingModule({ providers: [...ACTIVE_TAB_PROVIDERS] });
      tabs = TestBed.inject(TabsService);
      expect(await tabs.restore(layout)).toBe(true);
      expect(tabs.panes()[0].tabs.map((t) => t.view())).toEqual([null, null]);
    });

    it("does not store the log view, and a second open focuses the first", async () => {
      const first = tabs.openView("log");
      expect(tabs.openView("log")).toBe(first);
      expect(tabs.snapshot().panes[0].tabs.every((t) => t.view === null)).toBe(true);
    });

    it("closes, and the last tab of all becomes an empty tab", () => {
      const view = tabs.openView("settings");
      expect(tabs.closeTab(tabs.focusedPane().id, view.id)).toBe(true);
      expect(tabs.panes()[0].tabs.length).toBe(1);
      const only = tabs.openView("settings");
      tabs.closeTab(tabs.focusedPane().id, tabs.panes()[0].tabs[0].id);
      expect(tabs.panes()[0].tabs).toEqual([only]);
      expect(tabs.closeTab(tabs.focusedPane().id, only.id)).toBe(true);
      expect(tabs.activeTab().view()).toBeNull();
      expect(tabs.showWorkspace()).toBe(false);
    });

    it("is stored with the layout, not in the note history, and restored", async () => {
      await TestBed.inject(DocumentService).open("/v/a.md");
      tabs.openView("health");
      const layout = tabs.snapshot();
      expect(layout.panes[0].tabs.map((t) => [t.view, t.path, t.history])).toEqual([
        [null, "/v/a.md", [{ path: "/v/a.md", line: null, anchor: null }]],
        ["health", null, []],
      ]);

      TestBed.resetTestingModule();
      TestBed.configureTestingModule({ providers: [...ACTIVE_TAB_PROVIDERS] });
      tabs = TestBed.inject(TabsService);
      expect(await tabs.restore(JSON.parse(JSON.stringify(layout)))).toBe(true);
      const restored = tabs.panes()[0];
      expect(restored.tabs.map((t) => t.view())).toEqual([null, "health"]);
      expect(tabs.activeTab().view()).toBe("health");
    });

    it("restores a layout that holds only a view", async () => {
      tabs.openView("settings");
      const layout = JSON.parse(JSON.stringify(tabs.snapshot()));
      layout.panes[0].tabs = layout.panes[0].tabs.filter(
        (t: { view: string | null }) => t.view !== null,
      );
      layout.panes[0].active = 0;
      expect(await tabs.restore(layout)).toBe(true);
      expect(tabs.activeTab().view()).toBe("settings");
    });
  });

  describe("moving tabs", () => {
    it("reorders inside a pane", async () => {
      await tabs.openInNewTab("/v/a.md");
      await tabs.openInNewTab("/v/b.md");
      const ids = tabs.panes()[0].tabs.map((t) => t.id);
      tabs.moveTab(tabs.panes()[0].id, 0, 2);
      expect(tabs.panes()[0].tabs.map((t) => t.id)).toEqual([ids[1], ids[2], ids[0]]);
      tabs.moveTab(tabs.panes()[0].id, 5, 0);
      expect(tabs.panes()[0].tabs.map((t) => t.id)).toEqual([ids[1], ids[2], ids[0]]);
    });

    it("moves a tab into the other pane and drops a pane that is left empty", async () => {
      await tabs.openInNewTab("/v/a.md");
      await tabs.splitRight();
      const [left, right] = tabs.panes();
      const moving = left.tabs[1];
      tabs.moveTabToPane(left.id, moving.id, right.id, 0);
      expect(tabs.panes()[1].tabs[0]).toBe(moving);
      expect(tabs.panes()[1].activeId).toBe(moving.id);
      expect(tabs.focusedPane().id).toBe(right.id);
      for (const t of tabs.panes()[0].tabs) tabs.moveTabToPane(left.id, t.id, right.id, 0);
      expect(tabs.panes().length).toBe(1);
    });
  });

  describe("preview tab", () => {
    const paths = () => tabs.focusedPane().tabs.map((t) => t.doc.path());

    it("a click opens in the empty tab as the preview, the next click replaces it", async () => {
      await tabs.openPreview("/v/a.md");
      expect(paths()).toEqual(["/v/a.md"]);
      expect(tabs.isPreview(tabs.activeTab())).toBe(true);
      await tabs.openPreview("/v/b.md");
      expect(paths()).toEqual(["/v/b.md"]);
      expect(
        tabs
          .activeTab()
          .doc.historyState()
          .history.map((e) => e.path),
      ).toEqual(["/v/a.md", "/v/b.md"]);
    });

    it("adds the preview tab beside pinned tabs and keeps at most one", async () => {
      await tabs.openInNewTab("/v/a.md");
      await tabs.openPreview("/v/b.md");
      await tabs.openPreview("/v/c.md");
      expect(paths()).toEqual([null, "/v/a.md", "/v/c.md"]);
      expect(tabs.focusedPane().tabs.filter((t) => tabs.isPreview(t)).length).toBe(1);
      expect(shown()).toBe("/v/c.md");
    });

    it("shows a note that a pinned tab has instead of a second copy", async () => {
      await tabs.openInNewTab("/v/a.md");
      const pinned = tabs.activeTab();
      await tabs.openPreview("/v/b.md");
      await tabs.openPreview("/v/a.md");
      expect(tabs.activeTab()).toBe(pinned);
      expect(paths().filter((p) => p === "/v/a.md").length).toBe(1);
      expect(paths()).toContain("/v/b.md");
    });

    it("a double click pins the preview tab that shows the note, or opens a new tab", async () => {
      await tabs.openPreview("/v/a.md");
      await tabs.openPinned("/v/a.md");
      expect(tabs.activeTab().pinned()).toBe(true);
      await tabs.openPreview("/v/b.md");
      expect(paths()).toEqual(["/v/a.md", "/v/b.md"]);
      await tabs.openPinned("/v/c.md");
      expect(paths()).toEqual(["/v/a.md", "/v/b.md", "/v/c.md"]);
      expect(tabs.activeTab().pinned()).toBe(true);
      expect(tabs.focusedPane().tabs.filter((t) => tabs.isPreview(t)).length).toBe(1);
    });

    it("a double click while the first click still reads the note pins that tab", async () => {
      const click = tabs.openPreview("/v/a.md");
      const dbl = tabs.openPinned("/v/a.md");
      await Promise.all([click, dbl]);
      expect(paths()).toEqual(["/v/a.md"]);
      expect(tabs.activeTab().pinned()).toBe(true);
    });

    it("pins on the first edit, on a save, on Keep open and when the tab moves", async () => {
      const pins: Array<(t: ReturnType<TabsService["activeTab"]>) => unknown> = [
        (t) => t.doc.typed("/v/a.md", "x"),
        (t) => t.doc.write("/v/a.md", "x"),
        () => tabs.keepOpen(),
      ];
      for (const pin of pins) {
        tabs.reset();
        await tabs.openPreview("/v/a.md");
        await pin(tabs.activeTab());
        expect(tabs.activeTab().pinned()).toBe(true);
      }
      tabs.reset();
      await tabs.openInNewTab("/v/b.md");
      await tabs.openPreview("/v/a.md");
      tabs.moveTab(tabs.focusedPane().id, 2, 0);
      expect(tabs.focusedPane().tabs[0].pinned()).toBe(true);
    });

    it("never replaces a tab with unsaved text", async () => {
      await tabs.openPreview("/v/a.md");
      const first = tabs.activeTab();
      vi.spyOn(first.editor, "unsaved").mockReturnValue(true);
      await tabs.openPreview("/v/b.md");
      expect(first.doc.path()).toBe("/v/a.md");
      expect(paths()).toEqual(["/v/a.md", "/v/b.md"]);
    });

    it("views and new tabs are pinned", async () => {
      expect(tabs.newTab().pinned()).toBe(true);
      expect(tabs.openView("settings").pinned()).toBe(true);
      await tabs.openPreview("/v/a.md");
      expect(tabs.panes()[0].tabs.filter((t) => tabs.isPreview(t)).length).toBe(1);
    });

    it("drops the new preview tab again when the note cannot be opened", async () => {
      await tabs.openInNewTab("/v/a.md");
      await tabs.openPreview("/v/b.md");
      await tabs.openInNewTab("/v/c.md");
      const before = paths().length;
      await expect(tabs.openPreview("/v/missing.md")).rejects.toThrow("missing");
      expect(paths().length).toBe(before);
    });

    it("stores the preview state in the layout and restores it", async () => {
      await tabs.openInNewTab("/v/a.md");
      await tabs.openPreview("/v/b.md");
      const layout = tabs.snapshot();
      expect(layout.panes[0].tabs.map((t) => t.preview)).toEqual([false, false, true]);
      TestBed.resetTestingModule();
      TestBed.configureTestingModule({ providers: [...ACTIVE_TAB_PROVIDERS] });
      tabs = TestBed.inject(TabsService);
      expect(await tabs.restore(layout)).toBe(true);
      expect(tabs.focusedPane().tabs.map((t) => tabs.isPreview(t))).toEqual([false, false, true]);
    });

    it("restores at most one preview tab per pane", async () => {
      const state = (path: string, preview: boolean) => ({
        view: null,
        path,
        history: [path],
        index: 0,
        editing: false,
        line: null,
        preview,
      });
      await tabs.restore({
        panes: [{ tabs: [state("/v/a.md", true), state("/v/b.md", true)], active: 0 }],
        focused: 0,
        ratio: 0.5,
      });
      expect(tabs.focusedPane().tabs.map((t) => tabs.isPreview(t))).toEqual([true, false]);
    });

    it("with the setting off a click opens in the shown tab and Keep open does nothing", async () => {
      TestBed.inject(SettingsService).previewTabs.set(false);
      await tabs.openPreview("/v/a.md");
      await tabs.openPreview("/v/b.md");
      expect(paths()).toEqual(["/v/b.md"]);
      tabs.keepOpen();
      expect(tabs.activeTab().pinned()).toBe(false);
      await tabs.openPinned("/v/c.md");
      expect(paths()).toEqual(["/v/c.md"]);
    });
  });

  it("gives components created with a tab's injector that tab's services", async () => {
    @Component({ selector: "app-probe", template: "{{ doc.path() }}" })
    class Probe {
      readonly doc = inject(DocumentService);
    }
    @Component({
      selector: "app-host",
      imports: [NgComponentOutlet],
      template: '<ng-container *ngComponentOutlet="probe; injector: injector" />',
    })
    class Host {
      probe = Probe;
      injector = tabs.panes()[0].tabs[0].injector;
    }
    await TestBed.inject(DocumentService).open("/v/a.md");
    await tabs.openInNewTab("/v/b.md");
    const fixture = TestBed.createComponent(Host);
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).textContent).toBe("/v/a.md");
  });

  describe("openEpub", () => {
    it("opens a tab with the view epub and the book; the tab title is the book title", async () => {
      const tab = await tabs.openEpub("/v/Books/sample.epub");

      expect(tab.view()).toBe("epub");
      expect(tab.epub()?.path).toBe("/v/Books/sample.epub");
      expect(tab.epub()?.title).toBe("Nixe Sample Book");
      expect(tabs.activeTab()).toBe(tab);
      expect(tabs.showWorkspace()).toBe(true);
    });

    it("downloads the book of an https link and opens the local file once", async () => {
      const url = "https://example.org/books/sample.epub";
      const tab = await tabs.openEpub(url);

      expect(invoke).toHaveBeenCalledWith("download_epub", { url });
      expect(tab.epub()?.path).toBe("/data/books/sample-1.epub");
      const count = tabs.panes()[0].tabs.length;
      expect(await tabs.openEpub(url)).toBe(tab);
      expect(tabs.panes()[0].tabs.length).toBe(count);
    });

    it("opens no tab when the download is refused", async () => {
      invoke.mockImplementation(async (cmd: string) => {
        if (cmd === "download_epub") throw "book too large (limit 50 MB)";
        return undefined;
      });
      await expect(tabs.openEpub("https://example.org/big.epub")).rejects.toMatch("too large");
      expect(tabs.panes()[0].tabs.length).toBe(1);
    });

    it("focuses the tab that reads the book already", async () => {
      const first = await tabs.openEpub("/v/Books/sample.epub");
      await tabs.openInNewTab("/v/a.md");

      const again = await tabs.openEpub("/v/Books/sample.epub");

      expect(again).toBe(first);
      expect(tabs.activeTab()).toBe(first);
      expect(tabs.panes()[0].tabs.length).toBe(3);
    });

    it("opens no tab for a book that cannot be read", async () => {
      await expect(tabs.openEpub("/elsewhere/b.epub")).rejects.toMatch("outside");

      expect(tabs.panes()[0].tabs.length).toBe(1);
      expect(tabs.activeTab().view()).toBeNull();
    });

    it("does not store the reader tab with the layout", async () => {
      await tabs.openEpub("/v/Books/sample.epub");

      expect(tabs.snapshot().panes[0].tabs[0].view).toBeNull();
    });
  });
});

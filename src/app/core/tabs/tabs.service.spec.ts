// @vitest-environment jsdom
import "@angular/compiler";
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
import { ACTIVE_TAB_PROVIDERS, TabsService } from "./tabs.service";

const FILES: Record<string, string> = { "/v/a.md": "# A", "/v/b.md": "# B", "/v/c.md": "# C" };

describe("TabsService", () => {
  let tabs: TabsService;

  beforeAll(() => {
    TestBed.initTestEnvironment(BrowserTestingModule, platformBrowserTesting());
  });

  beforeEach(() => {
    invoke.mockReset();
    invoke.mockImplementation(async (cmd: string, args: { path: string }) => {
      if (cmd === "read_text_file") {
        if (!(args.path in FILES)) throw new Error("missing");
        return FILES[args.path];
      }
      if (cmd === "find_wiki_root") return "/v";
      if (cmd === "is_utf8_file") return true;
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
    await expect(tabs.openInNewTab("/v/missing.md")).rejects.toThrow();
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
    tabs.activeTab().editor.handle = { flush } as never;
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
      expect(tabs.panes().map((p) => p.tabs.map((t) => t.doc.path()))).toEqual([["/v/b.md"], ["/v/b.md"]]);
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
        expect(tabs.panes().map((p) => p.tabs[0].doc.content())).toEqual(["# A on disk", "# A on disk"]);
      } finally {
        FILES["/v/a.md"] = "# A";
      }
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
      expect(layout.panes[0].tabs[0]).toMatchObject({ history: ["/v/a.md", "/v/b.md"], index: 1, editing: false });
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

  it("gives components created with a tab's injector that tab's services", async () => {
    @Component({ selector: "app-probe", template: "{{ doc.path() }}" })
    class Probe {
      readonly doc = inject(DocumentService);
    }
    @Component({ selector: "app-host", imports: [NgComponentOutlet], template: "<ng-container *ngComponentOutlet=\"probe; injector: injector\" />" })
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
});

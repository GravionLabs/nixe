// @vitest-environment jsdom
import "@angular/compiler";
import { ElementRef, signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { BrowserTestingModule, platformBrowserTesting } from "@angular/platform-browser/testing";
import { beforeAll, describe, expect, it, vi } from "vitest";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

import { ShortcutService } from "../../core/commands/shortcut.service";
import type { Pane, Tab } from "../../core/tabs/tabs.service";
import { ACTIVE_TAB_PROVIDERS, TabsService } from "../../core/tabs/tabs.service";
import { WorkspaceComponent } from "./workspace.component";

type Items = {
  menu(): Array<{ action: string; shortcut?: string }>;
  items(pane: unknown): Array<{ label: string; missing?: boolean; modified?: boolean }>;
};

function tab(id: number, path: string, unsaved: boolean) {
  return {
    id,
    view: signal(null),
    doc: { path: signal(path), missing: signal(false) },
    editor: { unsaved: signal(unsaved) },
  } as unknown as Tab;
}

describe("WorkspaceComponent", () => {
  beforeAll(() => {
    try {
      TestBed.initTestEnvironment(BrowserTestingModule, platformBrowserTesting());
    } catch {
      // Already initialised by another spec in this worker.
    }
  });

  function itemsOf(tabs: Tab[]) {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        { provide: TabsService, useValue: {} },
        { provide: ShortcutService, useValue: { display: () => "Ctrl+W" } },
        { provide: ElementRef, useValue: new ElementRef(document.createElement("div")) },
      ],
    });
    const ws = TestBed.runInInjectionContext(() => new WorkspaceComponent());
    const pane = { id: 1, tabs, activeId: tabs[0].id } as Pane;
    return (ws as unknown as Items).items(pane);
  }

  it("shows the shortcut of close-tab in the tab menu", () => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        { provide: TabsService, useValue: {} },
        {
          provide: ShortcutService,
          useValue: { display: (id: string) => (id === "close-tab" ? "Ctrl+W" : "") },
        },
        { provide: ElementRef, useValue: new ElementRef(document.createElement("div")) },
      ],
    });
    const ws = TestBed.runInInjectionContext(() => new WorkspaceComponent());
    expect((ws as unknown as Items).menu()).toEqual([
      { action: "close", label: "Close", shortcut: "Ctrl+W" },
    ]);
  });

  it("marks only the tabs with unsaved edits", () => {
    const a = tab(1, "A.md", true);
    const b = tab(2, "B.md", false);
    expect(itemsOf([a, b]).map((i) => i.modified)).toEqual([true, false]);
  });

  it("follows the unsaved signal of a tab whose editor is gone", () => {
    const a = tab(1, "A.md", true);
    expect(itemsOf([a])[0].modified).toBe(true);
    (a.editor.unsaved as unknown as ReturnType<typeof signal<boolean>>).set(false);
    expect(itemsOf([a])[0].modified).toBe(false);
  });

  it("passes the missing state of a tab to the tab bar", async () => {
    invoke.mockImplementation(async (cmd: string) => (cmd === "read_text_file" ? "# A" : "/v"));
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        ...ACTIVE_TAB_PROVIDERS,
        { provide: ShortcutService, useValue: { display: () => "Ctrl+W" } },
        { provide: ElementRef, useValue: new ElementRef(document.body) },
      ],
    });
    const tabs = TestBed.inject(TabsService);
    const workspace = TestBed.runInInjectionContext(() => new WorkspaceComponent());
    const active = tabs.activeTab();
    await active.doc.open("/v/a.md");
    const pane = tabs.panes()[0];
    expect((workspace as unknown as Items).items(pane)[0]).toMatchObject({
      label: "a",
      missing: false,
    });
    active.doc.missing.set(true);
    expect((workspace as unknown as Items).items(pane)[0].missing).toBe(true);
  });
});

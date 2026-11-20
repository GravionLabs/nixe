// @vitest-environment jsdom
import "@angular/compiler";
import { ElementRef, signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import {
  BrowserTestingModule,
  platformBrowserTesting,
} from "@angular/platform-browser/testing";
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

import type { Pane, Tab } from "../../core/tabs/tabs.service";
import { TabsService } from "../../core/tabs/tabs.service";
import { WorkspaceComponent } from "./workspace.component";

function tab(id: number, path: string, unsaved: boolean) {
  return {
    id,
    view: signal(null),
    doc: { path: signal(path) },
    editor: { unsaved: signal(unsaved) },
  } as unknown as Tab;
}

describe("WorkspaceComponent tab items", () => {
  beforeAll(() => {
    try {
      TestBed.initTestEnvironment(
        BrowserTestingModule,
        platformBrowserTesting(),
      );
    } catch {
      // Already initialised by another spec in this worker.
    }
  });

  function items(tabs: Tab[]) {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        { provide: TabsService, useValue: {} },
        {
          provide: ElementRef,
          useValue: new ElementRef(document.createElement("div")),
        },
      ],
    });
    const ws = TestBed.runInInjectionContext(() => new WorkspaceComponent());
    const pane = { id: 1, tabs, activeId: tabs[0].id } as Pane;
    return (
      ws as unknown as { items(p: Pane): { id: string; modified?: boolean }[] }
    ).items(pane);
  }

  it("marks only the tabs with unsaved edits", () => {
    const a = tab(1, "A.md", true);
    const b = tab(2, "B.md", false);
    expect(items([a, b]).map((i) => i.modified)).toEqual([true, false]);
  });

  it("follows the unsaved signal of a tab whose editor is gone", () => {
    const a = tab(1, "A.md", true);
    expect(items([a])[0].modified).toBe(true);
    (a.editor.unsaved as unknown as ReturnType<typeof signal<boolean>>).set(
      false,
    );
    expect(items([a])[0].modified).toBe(false);
  });
});

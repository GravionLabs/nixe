// @vitest-environment jsdom
import "@angular/compiler";
import { TestBed } from "@angular/core/testing";
import { BrowserTestingModule, platformBrowserTesting } from "@angular/platform-browser/testing";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

import { ACTIVE_TAB_PROVIDERS, TabsService } from "../tabs/tabs.service";
import type { CompareInput } from "./compare";
import { CompareService } from "./compare.service";

const input = (path: string, newText: string | null = "new"): CompareInput => ({
  path,
  title: path.replace(".md", ""),
  oldLabel: "Last sync",
  newLabel: "Now",
  oldText: "old",
  newText,
});

describe("CompareService", () => {
  beforeAll(() => {
    TestBed.initTestEnvironment(BrowserTestingModule, platformBrowserTesting());
  });

  beforeEach(() => {
    localStorage.clear();
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ providers: [...ACTIVE_TAB_PROVIDERS] });
  });

  it("opens the versions as a tab of the main area", () => {
    const tabs = TestBed.inject(TabsService);
    TestBed.inject(CompareService).open(input("a.md"));
    const tab = tabs.activeTab();
    expect(tabs.panes()[0].tabs).toHaveLength(2);
    expect(tab.view()).toBe("compare");
    expect(tab.compare()).toEqual(input("a.md"));
    expect(tab.doc.path()).toBeNull();
  });

  it("reuses the tab that compares the same note", () => {
    const tabs = TestBed.inject(TabsService);
    const service = TestBed.inject(CompareService);
    service.open(input("a.md"));
    const first = tabs.activeTab();
    service.open(input("b.md"));
    service.open(input("a.md", null));
    expect(tabs.activeTab()).toBe(first);
    expect(first.compare()?.newText).toBeNull();
    expect(tabs.panes()[0].tabs).toHaveLength(3);
  });

  it("shows the rendered mode by default and remembers the chosen one", () => {
    expect(TestBed.inject(CompareService).mode()).toBe("rendered");
    TestBed.inject(CompareService).setMode("source");
    expect(localStorage.getItem("nixe.compare-mode")).toBe("source");
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ providers: [...ACTIVE_TAB_PROVIDERS] });
    expect(TestBed.inject(CompareService).mode()).toBe("source");
  });
});

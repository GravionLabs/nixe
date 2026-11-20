// @vitest-environment jsdom
import "@angular/compiler";
import { ElementRef } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { BrowserTestingModule, platformBrowserTesting } from "@angular/platform-browser/testing";
import { beforeAll, describe, expect, it, vi } from "vitest";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

import { ACTIVE_TAB_PROVIDERS, TabsService } from "../../core/tabs/tabs.service";
import { WorkspaceComponent } from "./workspace.component";

type Items = { items(pane: unknown): Array<{ label: string; missing?: boolean }> };

describe("WorkspaceComponent", () => {
  beforeAll(() => {
    TestBed.initTestEnvironment(BrowserTestingModule, platformBrowserTesting());
  });

  it("passes the missing state of a tab to the tab bar", async () => {
    invoke.mockImplementation(async (cmd: string) => (cmd === "read_text_file" ? "# A" : "/v"));
    TestBed.configureTestingModule({
      providers: [
        ...ACTIVE_TAB_PROVIDERS,
        { provide: ElementRef, useValue: new ElementRef(document.body) },
      ],
    });
    const tabs = TestBed.inject(TabsService);
    const workspace = TestBed.runInInjectionContext(() => new WorkspaceComponent());
    const tab = tabs.activeTab();
    await tab.doc.open("/v/a.md");
    const pane = tabs.panes()[0];
    expect((workspace as unknown as Items).items(pane)[0]).toMatchObject({
      label: "a",
      missing: false,
    });
    tab.doc.missing.set(true);
    expect((workspace as unknown as Items).items(pane)[0].missing).toBe(true);
  });
});

// @vitest-environment jsdom
import "@angular/compiler";
import { readFileSync } from "node:fs";
import { signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { BrowserTestingModule, platformBrowserTesting } from "@angular/platform-browser/testing";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";
import type { BaseResult, IndexStatus } from "../../core/file/backend";
import { IndexService } from "../../core/index/index.service";
import { SettingsService } from "../../core/settings/settings.service";
import { CURRENT_TAB, TabsService } from "../../core/tabs/tabs.service";
import { WorkspaceService } from "../../core/workspace/workspace.service";
import { BaseComponent } from "./base.component";

const invokeMock = vi.mocked(invoke);

const table = (name: string, unsupported: string[] = []): BaseResult => ({
  view: "All",
  columns: [
    { id: "file.name", label: "file.name" },
    { id: "count", label: "Count" },
    { id: "done", label: "done" },
    { id: "tags", label: "tags" },
  ],
  rows: [
    {
      path: `sub/${name}.md`,
      cells: [
        { type: "text", value: name },
        { type: "number", value: 3 },
        { type: "checkbox", value: true },
        { type: "list", value: ["a", "b"] },
      ],
    },
    {
      path: "Empty.md",
      cells: [
        { type: "text", value: "Empty" },
        { type: null, value: null },
        { type: null, value: null },
        { type: null, value: null },
      ],
    },
  ],
  unsupported,
});

type Query = (source: string) => Promise<BaseResult>;

/** The fake backend: `.base` files by path, and what `base_query` answers. */
function fakeBackend(query: Query) {
  invokeMock.mockImplementation(async (command: string, args?: unknown) => {
    const a = args as Record<string, string>;
    if (command === "read_text_file") return `source of ${a["path"]}`;
    if (command === "base_query") return query(a["source"]!);
    return undefined;
  });
}

function status(state: string): IndexStatus {
  return { state, done: 0, total: 0, notes: 0, error: null } as IndexStatus;
}

function render(previewTabs = true) {
  const base = signal<string | null>("/vault/Library.base");
  const index = { status: signal(status("ready")), revision: signal(0) };
  const tabs = {
    notice: signal<string | null>(null),
    openPreview: vi.fn().mockResolvedValue(undefined),
    openInNewTab: vi.fn().mockResolvedValue(undefined),
  };
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      { provide: CURRENT_TAB, useValue: { base } },
      { provide: IndexService, useValue: index },
      { provide: SettingsService, useValue: { previewTabs: signal(previewTabs) } },
      { provide: TabsService, useValue: tabs },
      { provide: WorkspaceService, useValue: { vaultRoot: signal("/vault") } },
    ],
  });
  TestBed.overrideComponent(BaseComponent, {
    set: {
      templateUrl: undefined,
      styleUrl: undefined,
      template: readFileSync("src/app/features/bases/base.component.html", "utf8"),
    },
  });
  const fixture = TestBed.createComponent(BaseComponent);
  const el = fixture.nativeElement as HTMLElement;
  const settle = async () => {
    for (let i = 0; i < 3; i++) {
      fixture.detectChanges();
      await new Promise((resolve) => setTimeout(resolve));
    }
    fixture.detectChanges();
  };
  const cells = () =>
    [...el.querySelectorAll("tbody tr")].map((tr) =>
      [...tr.querySelectorAll("td")].map((td) => td.textContent!.trim()),
    );
  const alert = () => el.querySelector('[role="alert"]')?.textContent?.trim() ?? null;
  return { base, index, tabs, el, fixture, settle, cells, alert };
}

describe("BaseComponent", () => {
  beforeAll(() => {
    TestBed.initTestEnvironment(BrowserTestingModule, platformBrowserTesting());
  });
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("shows the table of the file: headers, typed values, no message", async () => {
    fakeBackend(async () => table("Dune"));
    const view = render();
    await view.settle();

    expect(invokeMock).toHaveBeenCalledWith("base_query", {
      source: "source of /vault/Library.base",
      view: null,
    });
    const headers = [...view.el.querySelectorAll("thead th")].map((th) => th.textContent!.trim());
    expect(headers).toEqual(["file.name", "Count", "done", "tags"]);
    expect(view.cells()).toEqual([
      ["Dune", "3", "", "a, b"],
      ["Empty", "", "", ""],
    ]);
    const boxes = view.el.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
    expect(boxes.length).toBe(1);
    expect(boxes[0]!.checked).toBe(true);
    expect(view.el.querySelector('[role="status"]')).toBeNull();
  });

  it("names the unsupported parts", async () => {
    fakeBackend(async () => table("Dune", ["filters", "formulas"]));
    const view = render();
    await view.settle();

    expect(view.el.querySelector('[role="status"]')?.textContent?.trim()).toBe(
      "Not supported yet, so not applied: filters, formulas.",
    );
  });

  it("opens the note of a row on a click on its name, keeping the table", async () => {
    fakeBackend(async () => table("Dune"));
    const view = render();
    await view.settle();

    view.el.querySelector<HTMLButtonElement>("button.note-link")!.click();
    expect(view.tabs.openPreview).toHaveBeenCalledWith("/vault/sub/Dune.md");

    const off = render(false);
    await off.settle();
    off.tabs.openInNewTab.mockRejectedValue("gone");
    off.el.querySelector<HTMLButtonElement>("button.note-link")!.click();
    // Opening shows another tab, which destroys the table before the note was read.
    off.fixture.destroy();
    await new Promise((resolve) => setTimeout(resolve));
    expect(off.tabs.openInNewTab).toHaveBeenCalledWith("/vault/sub/Dune.md");
    expect(off.tabs.notice()).toBe("gone");
  });

  it("does not list the vault's notes for a base outside the vault", async () => {
    fakeBackend(async () => table("Dune"));
    const view = render();
    view.base.set("/vault-other/Library.base");
    await view.settle();

    expect(view.alert()).toBe("Bases outside the open vault are not supported yet.");
    expect(view.el.querySelector("table")).toBeNull();
  });

  it("reads the file again after a vault change", async () => {
    let name = "Dune";
    fakeBackend(async () => table(name));
    const view = render();
    await view.settle();

    name = "Emma";
    view.index.revision.set(1);
    await view.settle();

    expect(view.cells()[0]![0]).toBe("Emma");
  });

  it("waits for the index and reports an index that failed", async () => {
    fakeBackend(async () => table("Dune"));
    const view = render();
    view.index.status.set(status("scanning"));
    await view.settle();
    expect(view.el.textContent).toContain("Loading…");
    expect(invokeMock).not.toHaveBeenCalledWith("base_query", expect.anything());

    view.index.status.set(status("error"));
    await view.settle();
    expect(view.alert()).toBe("The vault index is not available.");

    view.index.status.set(status("ready"));
    await view.settle();
    expect(view.alert()).toBeNull();
    expect(view.cells().length).toBe(2);
  });

  it("shows the message of a failed query instead of the table and logs it", async () => {
    let fail = false;
    fakeBackend(async () => {
      if (fail) throw "Invalid YAML: bad";
      return table("Dune");
    });
    const view = render();
    await view.settle();

    fail = true;
    view.index.revision.set(1);
    await view.settle();

    expect(view.alert()).toBe("Invalid YAML: bad");
    expect(view.el.querySelector("table")).toBeNull();
    expect(invokeMock).toHaveBeenCalledWith("log_command_error", {
      command: "base_query",
      error: "Invalid YAML: bad",
    });
  });

  it.each(["answer", "failure"])(
    "ignores the late %s of an older query after a vault change",
    async (kind) => {
      let settleOld!: () => void;
      let queries = 0;
      fakeBackend((_source) => {
        if (++queries > 1) return Promise.resolve(table("New"));
        return new Promise((resolve, reject) => {
          settleOld = () => (kind === "answer" ? resolve(table("Old")) : reject("old failure"));
        });
      });
      const view = render();
      await view.settle();

      view.index.revision.set(1);
      await view.settle();
      settleOld();
      await view.settle();

      expect(view.cells()[0]![0]).toBe("New");
      expect(view.alert()).toBeNull();
    },
  );

  it("never shows the table of the previous file after the file switched", async () => {
    let settleOld!: () => void;
    fakeBackend((source) => {
      if (source.endsWith("Other.base")) return Promise.resolve(table("Other"));
      return new Promise((resolve) => {
        settleOld = () => resolve(table("Old"));
      });
    });
    const view = render();
    await view.settle();

    view.base.set("/vault/Other.base");
    await view.settle();
    settleOld();
    await view.settle();

    expect(view.cells()[0]![0]).toBe("Other");
    expect(view.el.querySelector("header")?.textContent).toContain("Other.base");
  });
});

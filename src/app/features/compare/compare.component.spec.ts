// @vitest-environment jsdom
import "@angular/compiler";
import { signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { BrowserTestingModule, platformBrowserTesting } from "@angular/platform-browser/testing";
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

import type { CompareInput } from "../../core/compare/compare";
import { CompareService } from "../../core/compare/compare.service";
import { MarkdownService } from "../../core/markdown/markdown.service";
import { CURRENT_TAB, TabsService } from "../../core/tabs/tabs.service";
import type { Tab } from "../../core/tabs/tabs.service";
import { WorkspaceService } from "../../core/workspace/workspace.service";
import { CompareComponent } from "./compare.component";

const input: CompareInput = {
  path: "notes/a.md",
  title: "a",
  oldLabel: "Last sync",
  newLabel: "Now",
  oldText: "one\ntwo",
  newText: "one\nthree\nfour",
};

function render(value: CompareInput | null, closeTab = vi.fn()) {
  const tab = { id: 7, compare: signal(value) } as unknown as Tab;
  const mode = signal<"rendered" | "source">("rendered");
  const setMode = vi.fn((m: "rendered" | "source") => mode.set(m));
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      { provide: CURRENT_TAB, useValue: tab },
      { provide: TabsService, useValue: { panes: () => [{ id: 1, tabs: [tab] }], closeTab } },
      { provide: CompareService, useValue: { mode, setMode } },
      { provide: MarkdownService, useValue: { render: (t: string) => `<p>${t}</p>` } },
      { provide: WorkspaceService, useValue: { vaultRoot: signal("/vault") } },
    ],
  });
  TestBed.overrideComponent(CompareComponent, { set: { styleUrl: undefined } });
  const fixture = TestBed.createComponent(CompareComponent);
  fixture.detectChanges();
  return { fixture, el: fixture.nativeElement as HTMLElement, setMode, closeTab };
}

describe("CompareComponent", () => {
  beforeAll(() => {
    TestBed.initTestEnvironment(BrowserTestingModule, platformBrowserTesting());
  });

  it("shows the title, the added and removed lines and the labels in the header", () => {
    const { el } = render(input);
    expect(el.querySelector(".title")?.textContent).toBe("a");
    expect(el.querySelector(".stat")?.textContent?.replace(/\s+/g, "")).toBe("+2−1");
    expect(el.querySelector(".range")?.textContent).toBe("Last sync → Now");
  });

  it("renders before and after side by side by default", () => {
    const { el } = render(input);
    expect(el.querySelectorAll(".rendered section")).toHaveLength(2);
    expect(el.querySelector(".diff")).toBeNull();
  });

  it("switches to the source diff and hands the choice to the service", () => {
    const { el, fixture, setMode } = render(input);
    el.querySelector<HTMLButtonElement>(".mode-source")!.click();
    fixture.detectChanges();
    expect(setMode).toHaveBeenCalledWith("source");
    expect(el.querySelectorAll(".diff .row.add")).toHaveLength(2);
    expect(el.querySelector(".mode-source")?.getAttribute("aria-pressed")).toBe("true");
  });

  it("shows one side and a note for an added note", () => {
    const { el } = render({ ...input, oldText: null });
    expect(el.querySelectorAll(".rendered .md")).toHaveLength(1);
    expect(el.querySelector(".rendered .status")?.textContent).toContain("does not exist");
  });

  it("shows an empty state without versions", () => {
    expect(render(null).el.textContent).toContain("Nothing to compare");
  });

  it("shows no action button without an action", () => {
    const { el } = render(input);
    expect(el.querySelector(".action")).toBeNull();
  });

  it("runs the action with its note and closes the tab when it is done", async () => {
    const run = vi.fn().mockResolvedValue(true);
    const { el, closeTab } = render({
      ...input,
      action: { label: "Restore", note: "The current version stays in the history", run },
    });
    expect(el.querySelector(".action .note")?.textContent).toBe(
      "The current version stays in the history",
    );
    const button = el.querySelector<HTMLButtonElement>(".action button")!;
    expect(button.textContent?.trim()).toBe("Restore");
    button.click();
    await new Promise((r) => setTimeout(r));
    expect(run).toHaveBeenCalled();
    expect(closeTab).toHaveBeenCalledWith(1, 7);
  });

  it("keeps the tab when the action fails", async () => {
    const run = vi.fn().mockResolvedValue(false);
    const { el, closeTab } = render({ ...input, action: { label: "Restore", note: "n", run } });
    el.querySelector<HTMLButtonElement>(".action button")!.click();
    await new Promise((r) => setTimeout(r));
    expect(closeTab).not.toHaveBeenCalled();
  });
});

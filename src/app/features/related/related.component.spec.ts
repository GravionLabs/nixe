// @vitest-environment jsdom
import "@angular/compiler";
import { readFileSync } from "node:fs";
import { signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { BrowserTestingModule, platformBrowserTesting } from "@angular/platform-browser/testing";
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

import type { RelatedNote } from "../../core/file/backend";
import { DocumentService } from "../../core/file/document.service";
import { RelatedService } from "../../core/index/related.service";
import { LinkPreviewService } from "../../core/preview/link-preview.service";
import { TabsService } from "../../core/tabs/tabs.service";
import { WorkspaceService } from "../../core/workspace/workspace.service";
import { RelatedComponent } from "./related.component";
import { pressArrow } from "../../../testing/list-keys";

const note = (path: string, reasons: string[]): RelatedNote => ({
  path,
  title: path.replace(/\.md$/, ""),
  score: 10,
  reasons,
});

function render(state: "idle" | "loading" | "error" | "ready", notes: RelatedNote[]) {
  const open = vi.fn().mockResolvedValue(undefined);
  const openInNewTab = vi.fn().mockResolvedValue(undefined);
  const openPinned = vi.fn().mockResolvedValue(undefined);
  const refresh = vi.fn();
  const preview = { hover: vi.fn(), leave: vi.fn() };
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      {
        provide: RelatedService,
        useValue: { state: signal(state), notes: signal(notes), key: signal("k"), refresh },
      },
      { provide: DocumentService, useValue: { open } },
      { provide: TabsService, useValue: { openInNewTab, openPinned, openPreview: open } },
      { provide: LinkPreviewService, useValue: preview },
      { provide: WorkspaceService, useValue: { vaultRoot: signal("/vault") } },
    ],
  });
  TestBed.overrideComponent(RelatedComponent, {
    set: {
      templateUrl: undefined,
      styleUrl: undefined,
      template: readFileSync("src/app/features/related/related.component.html", "utf8"),
    },
  });
  const fixture = TestBed.createComponent(RelatedComponent);
  fixture.detectChanges();
  return {
    el: fixture.nativeElement as HTMLElement,
    open,
    openInNewTab,
    openPinned,
    refresh,
    preview,
  };
}

describe("RelatedComponent", () => {
  beforeAll(() => {
    TestBed.initTestEnvironment(BrowserTestingModule, platformBrowserTesting());
  });

  it("lists the notes with the reasons they are related", () => {
    const { el, refresh } = render("ready", [
      note("B.md", ["links here", "2 shared tags"]),
      note("C.md", ["both linked from Hub"]),
    ]);
    expect(refresh).toHaveBeenCalled();
    const rows = el.querySelectorAll("button[hx-list-row]");
    expect(rows.length).toBe(2);
    expect(rows[0].textContent).toContain("B");
    expect(rows[0].textContent).toContain("links here, 2 shared tags");
    expect(rows[1].textContent).toContain("both linked from Hub");
  });

  it("opens a note on click, in a new tab with ⌘/Ctrl", () => {
    const { el, open, openInNewTab, openPinned } = render("ready", [
      note("sub/B.md", ["links here"]),
    ]);
    const button = el.querySelector("button")!;
    button.click();
    expect(open).toHaveBeenCalledWith("/vault/sub/B.md");
    button.dispatchEvent(new MouseEvent("click", { bubbles: true, ctrlKey: true }));
    expect(openInNewTab).toHaveBeenCalledWith("/vault/sub/B.md");
    button.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    expect(openPinned).toHaveBeenCalledWith("/vault/sub/B.md");
  });

  it("previews the note on hover and closes on leave", () => {
    const { el, preview } = render("ready", [note("B.md", ["links here"])]);
    const button = el.querySelector("button")!;
    button.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, metaKey: true }));
    expect(preview.hover).toHaveBeenCalledWith("B.md", expect.anything(), true);
    button.dispatchEvent(new MouseEvent("mouseleave"));
    expect(preview.leave).toHaveBeenCalled();
  });

  it("says so when nothing is related, while indexing and on an index error", () => {
    expect(render("ready", []).el.textContent).toContain("No related notes");
    expect(render("loading", []).el.textContent).toContain("Indexing");
    expect(render("error", []).el.querySelector("[role=alert]")).not.toBeNull();
  });

  it("moves through the rows with the arrows; none is selected or current", () => {
    const { el } = render("ready", [note("B.md", []), note("C.md", [])]);
    const rows = el.querySelectorAll<HTMLButtonElement>("button[hx-list-row]");
    expect(el.querySelector("[aria-current], [aria-pressed]")).toBeNull();
    rows[0].focus();
    pressArrow(rows[0], "ArrowDown");
    expect(document.activeElement).toBe(rows[1]);
  });
});

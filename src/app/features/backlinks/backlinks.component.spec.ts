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

import type { Backlink, UnlinkedMention } from "../../core/file/backend";
import { TabsService } from "../../core/tabs/tabs.service";
import type { BacklinksState, OutgoingLink } from "../../core/index/backlinks.service";
import { BacklinksService } from "../../core/index/backlinks.service";
import { LinkPreviewService } from "../../core/preview/link-preview.service";
import { WorkspaceService } from "../../core/workspace/workspace.service";
import { BacklinksComponent } from "./backlinks.component";

const back: Backlink = {
  source: "B.md",
  heading: null,
  block: null,
  alias: null,
  kind: "link",
  line: 7,
  context: "see [[A]] here",
};
const out = (label: string, resolved: string | null): OutgoingLink => ({
  label,
  resolved,
  heading: null,
  line: 1,
  kind: "link",
});

const mention: UnlinkedMention = {
  source: "M.md",
  line: 3,
  start: 4,
  end: 5,
  context: "see a here",
  text: "a",
};

function render(
  state: BacklinksState,
  backlinks: Backlink[],
  outgoing: OutgoingLink[],
  unlinked: UnlinkedMention[] = [],
) {
  const loadUnlinked = vi.fn();
  const linkMention = vi.fn().mockResolvedValue(undefined);
  const open = vi.fn().mockResolvedValue(undefined);
  const openPinned = vi.fn().mockResolvedValue(undefined);
  const refresh = vi.fn();
  const preview = { hover: vi.fn(), leave: vi.fn() };
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      {
        provide: BacklinksService,
        useValue: {
          state: signal(state),
          backlinks: signal(backlinks),
          outgoing: signal(outgoing),
          key: signal("k"),
          unlinked: signal(unlinked),
          unlinkedState: signal("ready"),
          loadUnlinked,
          linkMention,
          refresh,
        },
      },
      { provide: TabsService, useValue: { openPreview: open, openPinned } },
      { provide: LinkPreviewService, useValue: preview },
      { provide: WorkspaceService, useValue: { vaultRoot: signal("/vault") } },
    ],
  });
  TestBed.overrideComponent(BacklinksComponent, {
    set: {
      templateUrl: undefined,
      styleUrl: undefined,
      template: readFileSync("src/app/features/backlinks/backlinks.component.html", "utf8"),
    },
  });
  const fixture = TestBed.createComponent(BacklinksComponent);
  fixture.detectChanges();
  return {
    el: fixture.nativeElement as HTMLElement,
    open,
    openPinned,
    refresh,
    preview,
    loadUnlinked,
    linkMention,
    fixture,
  };
}

describe("BacklinksComponent", () => {
  beforeAll(() => {
    TestBed.initTestEnvironment(BrowserTestingModule, platformBrowserTesting());
  });

  it("lists backlinks with context, marks unresolved links and opens a backlink at its line", () => {
    const { el, open, refresh } = render("ready", [back], [out("C", "C.md"), out("Gone", null)]);
    expect(refresh).toHaveBeenCalled();
    expect(el.textContent).toContain("see [[A]] here");
    const buttons = el.querySelectorAll("button");
    expect(buttons[1].disabled).toBe(false);
    expect(buttons[2].disabled).toBe(true);
    expect(buttons[2].textContent).toContain("unresolved");
    buttons[0].click();
    expect(open).toHaveBeenCalledWith("/vault/B.md", { line: 7, anchor: null });
  });

  it("previews the note of a row on hover and closes on leave", () => {
    const { el, preview } = render("ready", [back], [out("C", "C.md"), out("Gone", null)]);
    const buttons = el.querySelectorAll("button");
    buttons[0].dispatchEvent(new MouseEvent("mousemove", { bubbles: true, metaKey: true }));
    expect(preview.hover).toHaveBeenLastCalledWith("B.md", expect.anything(), true);
    buttons[1].dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
    expect(preview.hover).toHaveBeenLastCalledWith("C.md", expect.anything(), false);
    buttons[1].dispatchEvent(new MouseEvent("mouseleave"));
    expect(preview.leave).toHaveBeenCalled();
  });

  it("says so when there are no links", () => {
    const { el } = render("ready", [], []);
    expect(el.textContent).toContain("No backlinks");
    expect(el.textContent).toContain("No outgoing links");
    // Only the fold button of the unlinked mentions.
    expect(el.querySelectorAll("button").length).toBe(1);
  });

  it("a double click on a backlink keeps the note in a tab of its own", () => {
    const { el, openPinned } = render("ready", [back], []);
    el.querySelector("li button")!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    expect(openPinned).toHaveBeenCalledWith("/vault/B.md", { line: 7, anchor: null });
  });

  it("keeps the unlinked mentions collapsed and unread until they are opened", () => {
    const { el, loadUnlinked, fixture } = render("ready", [], [], [mention]);
    const fold = el.querySelector<HTMLButtonElement>("button.fold")!;
    expect(fold.getAttribute("aria-expanded")).toBe("false");
    expect(el.textContent).not.toContain("see a here");
    expect(loadUnlinked).not.toHaveBeenCalled();
    fold.click();
    fixture.detectChanges();
    expect(fold.getAttribute("aria-expanded")).toBe("true");
    expect(loadUnlinked).toHaveBeenCalled();
    expect(el.textContent).toContain("see a here");
    expect(el.textContent).toContain("M.md");
  });

  it("turns a mention into a link with its button and opens it at its line", () => {
    const { el, linkMention, open, fixture } = render("ready", [], [], [mention]);
    el.querySelector<HTMLButtonElement>("button.fold")!.click();
    fixture.detectChanges();
    el.querySelector<HTMLButtonElement>("button.link-it")!.click();
    expect(linkMention).toHaveBeenCalledWith(mention);
    el.querySelector<HTMLButtonElement>("button.open")!.click();
    expect(open).toHaveBeenCalledWith("/vault/M.md", { line: 3, anchor: null });
  });

  it("says so when nothing is mentioned", () => {
    const { el, fixture } = render("ready", [], [], []);
    el.querySelector<HTMLButtonElement>("button.fold")!.click();
    fixture.detectChanges();
    expect(el.textContent).toContain("No unlinked mentions");
  });

  it("reports a failing link as an error", async () => {
    const { el, linkMention, fixture } = render("ready", [], [], [mention]);
    const errors: string[] = [];
    fixture.componentInstance.failed.subscribe((e: string) => errors.push(e));
    linkMention.mockRejectedValue("M.md changed");
    el.querySelector<HTMLButtonElement>("button.fold")!.click();
    fixture.detectChanges();
    el.querySelector<HTMLButtonElement>("button.link-it")!.click();
    await fixture.whenStable();
    expect(errors).toEqual(["M.md changed"]);
  });

  it("shows a loading note while the index is being built", () => {
    const { el } = render("loading", [], []);
    expect(el.textContent).toContain("Indexing the vault");
    expect(el.textContent).not.toContain("No backlinks");
  });
});

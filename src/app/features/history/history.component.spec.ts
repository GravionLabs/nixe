// @vitest-environment jsdom
import "@angular/compiler";
import { readFileSync } from "node:fs";
import { signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { BrowserTestingModule, platformBrowserTesting } from "@angular/platform-browser/testing";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

import type { TimelineEntry } from "../../core/git/history.service";
import { HistoryService } from "../../core/git/history.service";
import { MarkdownService } from "../../core/markdown/markdown.service";
import { WorkspaceService } from "../../core/workspace/workspace.service";
import { By } from "@angular/platform-browser";
import { HxMenu } from "@gravionlabs/helix-ui";
import { HistoryComponent, formatCommitTime } from "./history.component";
import { pressArrow } from "../../../testing/list-keys";

const NOW = Date.UTC(1970, 0, 2, 12, 0, 0);
const timeline: TimelineEntry[] = [
  { id: null, author: "", time: 0, message: "Uncommitted changes", path: "a.md" },
  { id: "abc1234", author: "Ann", time: 86_400, message: "edit", path: "a.md" },
  {
    id: "def5678",
    author: "Ann",
    time: 86_400,
    message: "rename: a.md -> b.md, links in 2 notes",
    path: "b.md",
    operation: "rename",
  },
];

function render(
  _unused: null,
  notePath: string | null = "a.md",
  entries: TimelineEntry[] = timeline,
  extra: { available?: boolean; deleted?: unknown[]; recent?: unknown[] } = {},
) {
  const available = extra.available ?? true;
  const recent = extra.recent ?? [];
  const deleted = extra.deleted ?? [
    {
      path: "dir/gone.md",
      id: "d1",
      parent: "p1",
      author: "Ann",
      time: Math.floor(NOW / 1000) - 21 * 86_400,
      message: "delete",
    },
    { path: "other.md", id: "d2", parent: "p2", author: "Ann", time: 0, message: "delete" },
  ];
  const loadMore = vi.fn().mockResolvedValue(undefined);
  const open = vi.fn().mockResolvedValue(undefined);
  const reviewRestore = vi.fn().mockResolvedValue(undefined);
  const compareWithCurrent = vi.fn().mockResolvedValue(undefined);
  const compareBetween = vi.fn().mockResolvedValue(undefined);
  const restoreDeleted = vi.fn().mockResolvedValue(true);
  const reviewDeleted = vi.fn().mockResolvedValue(undefined);
  const openRecent = vi.fn().mockResolvedValue(undefined);
  const versionText = vi.fn().mockResolvedValue("whole version");
  const notice = signal<string | null>(null);
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      {
        provide: HistoryService,
        useValue: {
          notePath: signal(notePath),
          timeline: signal(entries),
          error: signal(null),
          loading: signal(false),
          loadMore,
          open,
          reviewRestore,
          compareWithCurrent,
          compareBetween,
          restoreDeleted,
          reviewDeleted,
          openRecent,
          available: signal(available),
          recent: signal(recent),
          versionText,
          notice,
          deleted: signal(deleted),
        },
      },
      { provide: MarkdownService, useValue: { render: (t: string) => `<p>${t}</p>` } },
      { provide: WorkspaceService, useValue: { vaultRoot: signal("/vault") } },
    ],
  });
  TestBed.overrideComponent(HistoryComponent, {
    set: {
      templateUrl: undefined,
      styleUrl: undefined,
      template: readFileSync("src/app/features/history/history.component.html", "utf8"),
    },
  });
  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
  const fixture = TestBed.createComponent(HistoryComponent);
  fixture.detectChanges();
  return {
    fixture,
    el: fixture.nativeElement as HTMLElement,
    loadMore,
    open,
    reviewRestore,
    compareWithCurrent,
    compareBetween,
    restoreDeleted,
    reviewDeleted,
    openRecent,
    versionText,
    notice,
  };
}

describe("HistoryComponent", () => {
  beforeAll(() => {
    TestBed.initTestEnvironment(BrowserTestingModule, platformBrowserTesting());
  });

  it("formats the commit time in UTC", () => {
    expect(formatCommitTime(86_400)).toBe("1970-01-02 00:00");
  });

  it("lists the uncommitted state first, then date, author and message of a commit", () => {
    const { el } = render(null);
    const rows = [...el.querySelectorAll(".timeline li:not(.day)")].map((l) =>
      l.textContent!.replace(/\s+/g, " ").trim(),
    );
    expect(rows[0]).toContain("Uncommitted changes");
    expect(rows[1]).toContain("edit");
    expect(rows[1]).toContain("12 hours ago");
    expect(rows[1].includes("Ann")).toBe(false);
  });

  it("names the operation of a commit that a vault operation wrote", () => {
    const { el } = render(null);
    const rows = el.querySelectorAll(".timeline li:not(.day)");
    expect(rows[1].querySelector(".operation")).toBeNull();
    expect(rows[2].querySelector(".operation")?.textContent).toBe("✎");
    expect(rows[2].textContent).toContain("Renamed: a.md → b.md");
    expect(rows[2].textContent).not.toContain("links in 2 notes");
  });

  it("shows the note title with the folder below it in the header", () => {
    const { el } = render(null, "notes/a.md");
    expect(el.querySelector("header .title")?.textContent).toBe("a");
    expect(el.querySelector("header .folder")?.textContent).toBe("notes");
  });

  it("groups the entries by day and gives the exact time as tooltip", () => {
    const { el } = render(null);
    expect([...el.querySelectorAll(".day")].map((d) => d.textContent)).toEqual(["Now", "Today"]);
    expect(el.querySelector(".when")?.getAttribute("title")).toMatch(/^1970-01-02 \d\d:\d\d$/);
  });

  it("shows an automatic backup as Automatic save", () => {
    const { el } = render(null, "a.md", [
      {
        id: "x1",
        author: "Ann",
        time: 86_400,
        message: "vault backup: 1970-01-02 00:00:00",
        path: "a.md",
      },
    ]);
    expect(el.querySelector(".timeline .message")?.textContent?.trim()).toBe("Automatic save");
  });

  it("shows the author only when the note has more than one", () => {
    const two: TimelineEntry[] = [
      { id: "x1", author: "Ann", time: 86_400, message: "a", path: "a.md" },
      { id: "x2", author: "Bob", time: 86_400, message: "b", path: "a.md" },
    ];
    const { el } = render(null, "a.md", two);
    const metas = [...el.querySelectorAll(".timeline .meta")].map((m) => m.textContent);
    expect(metas[0]).toContain("Ann");
    expect(metas[1]).toContain("Bob");
  });

  function menuItems(fixture: ReturnType<typeof render>["fixture"], el: HTMLElement) {
    const row = el.querySelectorAll<HTMLElement>(".timeline li:not(.day)")[1];
    row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    fixture.detectChanges();
    const menu = fixture.debugElement.query(By.directive(HxMenu)).componentInstance as HxMenu;
    return menu.model() as { label: string; command: () => void }[];
  }

  it("offers compare, restore and copy in a context menu", () => {
    const { fixture, el, reviewRestore, compareWithCurrent } = render(null);
    const items = menuItems(fixture, el);
    expect(items.map((i) => i.label)).toEqual([
      "Compare with current version",
      "Compare with…",
      "Restore this version",
      "Copy content",
    ]);
    items[0].command();
    expect(compareWithCurrent).toHaveBeenCalledWith(timeline[1]);
    items[2].command();
    expect(reviewRestore).toHaveBeenCalledWith(timeline[1]);
  });

  it("picks the second version after Compare with…", () => {
    const { fixture, el, open, compareBetween } = render(null);
    menuItems(fixture, el)[1].command();
    fixture.detectChanges();
    expect(el.querySelector(".pick")?.textContent).toContain("Pick the version");
    el.querySelectorAll<HTMLButtonElement>(".timeline li > button")[2].click();
    fixture.detectChanges();
    expect(compareBetween).toHaveBeenCalledWith(timeline[1], timeline[2]);
    expect(open).not.toHaveBeenCalled();
    expect(el.querySelector(".pick")).toBeNull();
  });

  it("selects the row of the version to compare with", () => {
    const { fixture, el } = render(null);
    const rows = el.querySelectorAll<HTMLButtonElement>(".timeline button[hx-list-row]");
    expect(el.querySelector(".hx-list-row-selected")).toBeNull();
    expect(rows[1].getAttribute("aria-pressed")).toBeNull();
    menuItems(fixture, el)[1].command();
    fixture.detectChanges();
    expect(rows[1].classList.contains("hx-list-row-selected")).toBe(true);
    expect(rows[1].getAttribute("aria-pressed")).toBe("true");
    expect(el.querySelectorAll(".hx-list-row-selected").length).toBe(1);
  });

  it("moves through the versions with the arrows", () => {
    const { el } = render(null);
    const rows = el.querySelectorAll<HTMLButtonElement>(".timeline button[hx-list-row]");
    rows[0].focus();
    pressArrow(rows[0], "ArrowDown");
    expect(document.activeElement).toBe(rows[1]);
  });

  it("cancels the pick without comparing", () => {
    const { fixture, el, open, compareBetween } = render(null);
    menuItems(fixture, el)[1].command();
    fixture.detectChanges();
    el.querySelector<HTMLButtonElement>(".cancel-pick")!.click();
    fixture.detectChanges();
    expect(el.querySelector(".pick")).toBeNull();
    el.querySelectorAll<HTMLButtonElement>(".timeline button")[1].click();
    expect(open).toHaveBeenCalledWith(timeline[1]);
    expect(compareBetween).not.toHaveBeenCalled();
  });

  it("opens a version in the main area on click and loads older entries near the end", () => {
    const { el, open, loadMore } = render(null);
    el.querySelectorAll<HTMLButtonElement>(".timeline button")[1].click();
    expect(open).toHaveBeenCalledWith(timeline[1]);
    el.querySelector(".timeline")!.dispatchEvent(new Event("scroll"));
    expect(loadMore).toHaveBeenCalled();
  });

  it("renders no diff in the side panel", () => {
    const { el } = render(null);
    expect(el.querySelector("app-diff")).toBeNull();
    expect(el.querySelector(".toolbar")).toBeNull();
    expect(el.querySelector("button.selected")).toBeNull();
  });

  it("asks for a note when none is open", () => {
    const { el } = render(null, null, [], { available: false });
    expect(el.textContent).toContain("Open a note");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("offers Restore this version and Copy on commits only", () => {
    const { el, reviewRestore } = render(null);
    const rows = el.querySelectorAll(".timeline li:not(.day)");
    expect(rows[0].querySelector(".restore")).toBeNull();
    expect(rows[1].querySelector(".copy")?.textContent).toContain("Copy content");
    rows[1].querySelector<HTMLButtonElement>(".restore")!.click();
    expect(reviewRestore).toHaveBeenCalledWith(timeline[1]);
  });

  it("copies the whole version, or the selected part when text is selected", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const { el, notice } = render(null);
    const copy = el.querySelector<HTMLButtonElement>(".copy")!;
    copy.click();
    await new Promise((r) => setTimeout(r));
    expect(writeText).toHaveBeenLastCalledWith("whole version");
    vi.spyOn(window, "getSelection").mockReturnValue({ toString: () => "part" } as Selection);
    copy.click();
    await new Promise((r) => setTimeout(r));
    expect(writeText).toHaveBeenLastCalledWith("part");
    expect(notice()).toBe("Copied the selection");
  });

  it("lists the trash with title, folder and the time of the deletion; Restore restores", () => {
    const { el, restoreDeleted } = render(null);
    const li = el.querySelector(".deleted app-note-row")!;
    expect(li.querySelector("button[hx-list-row]")!.getAttribute("title")).toBe("dir/gone.md");
    expect(li.querySelector(".title")!.textContent).toBe("gone");
    expect(li.querySelector(".folder")!.textContent).toBe("dir");
    expect(li.querySelector(".hx-list-row-meta")!.textContent).toContain("deleted 21 days ago");
    li.querySelector<HTMLButtonElement>("button:not([hx-list-row])")!.click();
    expect(restoreDeleted).toHaveBeenCalledWith(expect.objectContaining({ path: "dir/gone.md" }));
  });

  it("shows the last content of a deleted note on a click", () => {
    const { el, reviewDeleted } = render(null);
    el.querySelector<HTMLButtonElement>(".deleted button[hx-list-row]")!.click();
    expect(reviewDeleted).toHaveBeenCalledWith(expect.objectContaining({ path: "dir/gone.md" }));
  });

  it("narrows the trash by title and folder", () => {
    const { fixture, el } = render(null);
    const filter = el.querySelector<HTMLInputElement>("input.filter")!;
    const type = (v: string) => {
      filter.value = v;
      filter.dispatchEvent(new Event("input"));
      fixture.detectChanges();
    };
    type("DIR");
    expect(el.querySelectorAll(".deleted button[hx-list-row]").length).toBe(1);
    type("other");
    expect(el.querySelector(".deleted .title")!.textContent).toBe("other");
    type("zzz");
    expect(el.querySelector(".deleted")!.textContent).toContain("No deleted note matches");
  });

  it("shows an empty trash", () => {
    const { el } = render(null, "a.md", timeline, { deleted: [] });
    expect(el.querySelector(".deleted")!.textContent).toContain("The trash is empty");
    expect(el.querySelector("input.filter")).toBeNull();
  });

  it("lists the recently changed notes while no note is open and opens one on a click", () => {
    const recent = [
      {
        path: "dir/new.md",
        id: "r1",
        author: "A",
        time: Math.floor(NOW / 1000) - 3600,
        message: "m",
      },
    ];
    const { el, openRecent } = render(null, null, [], { recent });
    const row = el.querySelector(".recent app-note-row")!;
    expect(row.querySelector(".title")!.textContent).toBe("new");
    expect(row.querySelector(".folder")!.textContent).toBe("dir");
    expect(row.querySelector(".hx-list-row-meta")!.textContent).toContain("1 hour ago");
    row.querySelector<HTMLButtonElement>("button[hx-list-row]")!.click();
    expect(openRecent).toHaveBeenCalledWith(expect.objectContaining({ path: "dir/new.md" }));
  });

  it("shows empty states for a vault without versions", () => {
    const { el } = render(null, null, [], { deleted: [], recent: [] });
    expect(el.querySelector(".recent")!.textContent).toContain("No versions yet");
    expect(el.querySelector(".deleted")!.textContent).toContain("The trash is empty");
  });

  it("hides recent notes and the trash without a repository", () => {
    const { el } = render(null, null, [], { available: false });
    expect(el.textContent).toContain("Open a note to see its history.");
    expect(el.querySelector(".deleted")).toBeNull();
  });

  it("hides the recently changed notes while a note is open", () => {
    const { el } = render(null);
    expect(el.querySelector(".recent")).toBeNull();
  });
});

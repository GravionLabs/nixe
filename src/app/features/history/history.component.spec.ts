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

import type { Comparison, TimelineEntry } from "../../core/git/history.service";
import { HistoryService } from "../../core/git/history.service";
import { MarkdownService } from "../../core/markdown/markdown.service";
import { WorkspaceService } from "../../core/workspace/workspace.service";
import { By } from "@angular/platform-browser";
import { HxMenu } from "@gravionlabs/helix-ui";
import { HistoryComponent, formatCommitTime } from "./history.component";

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
  comparison: Comparison | null,
  notePath: string | null = "a.md",
  entries: TimelineEntry[] = timeline,
) {
  const loadMore = vi.fn().mockResolvedValue(undefined);
  const select = vi.fn().mockResolvedValue(undefined);
  const restore = vi.fn().mockResolvedValue(undefined);
  const restoreDeleted = vi.fn().mockResolvedValue(undefined);
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
          selection: signal(["abc1234"]),
          comparison: signal(comparison),
          error: signal(null),
          loading: signal(false),
          loadMore,
          select,
          restore,
          restoreDeleted,
          versionText,
          notice,
          deleted: signal([
            { path: "gone.md", id: "d1", parent: "p1", author: "Ann", time: 0, message: "delete" },
          ]),
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
    select,
    restore,
    restoreDeleted,
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
    expect(el.querySelector("button.selected")?.textContent).toContain("edit");
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

  it("offers Restore this version and Copy content in a context menu", () => {
    const { fixture, el, restore } = render(null);
    const row = el.querySelectorAll<HTMLElement>(".timeline li:not(.day)")[1];
    row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    fixture.detectChanges();
    const menu = fixture.debugElement.query(By.directive(HxMenu)).componentInstance as HxMenu;
    const items = menu.model() as { label: string; command: () => void }[];
    expect(items.map((i) => i.label)).toEqual(["Restore this version", "Copy content"]);
    items[0].command();
    expect(restore).toHaveBeenCalledWith(timeline[1]);
  });

  it("selects an entry on click and loads older entries near the end of the list", () => {
    const { el, select, loadMore } = render(null);
    el.querySelectorAll<HTMLButtonElement>(".timeline button")[1].click();
    expect(select).toHaveBeenCalledWith(timeline[1]);
    el.querySelector(".timeline")!.dispatchEvent(new Event("scroll"));
    expect(loadMore).toHaveBeenCalled();
  });

  it("shows the source diff with word highlighting, then the rendered versions", () => {
    const { el, fixture } = render({
      oldText: "the quick fox",
      newText: "the slow fox",
      oldLabel: "before",
      newLabel: "abc1234",
      path: "a.md",
    });
    expect(el.querySelector(".row.del")).not.toBeNull();
    expect(el.querySelector(".row.add .word")?.textContent).toBe("slow");
    expect(el.querySelector(".stat")?.textContent).toContain("+1");
    const rendered = [...el.querySelectorAll<HTMLButtonElement>(".toolbar button")].find(
      (b) => b.textContent?.trim() === "Rendered",
    )!;
    rendered.click();
    fixture.detectChanges();
    expect(el.querySelector(".diff")).toBeNull();
    expect([...el.querySelectorAll(".md")].map((m) => m.textContent)).toEqual([
      "the quick fox",
      "the slow fox",
    ]);
  });

  it("asks for a note when none is open", () => {
    const { el } = render(null, null);
    expect(el.textContent).toContain("Open a note");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("offers Restore this version and Copy on commits only", () => {
    const { el, restore } = render(null);
    const rows = el.querySelectorAll(".timeline li:not(.day)");
    expect(rows[0].querySelector(".restore")).toBeNull();
    expect(rows[1].querySelector(".copy")?.textContent).toContain("Copy content");
    rows[1].querySelector<HTMLButtonElement>(".restore")!.click();
    expect(restore).toHaveBeenCalledWith(timeline[1]);
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

  it("lists the deleted notes with a Restore button", () => {
    const { el, restoreDeleted } = render(null);
    const li = el.querySelector(".deleted li")!;
    expect(li.querySelector(".main")!.getAttribute("title")).toBe("gone.md");
    li.querySelector<HTMLButtonElement>("button:not(.main)")!.click();
    expect(restoreDeleted).toHaveBeenCalledWith(expect.objectContaining({ path: "gone.md" }));
  });
});

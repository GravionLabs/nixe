// @vitest-environment jsdom
import "@angular/compiler";
import { signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { BrowserTestingModule, platformBrowserTesting } from "@angular/platform-browser/testing";
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

import { pressArrow } from "../../../testing/list-keys";
import type { Bookmark } from "../../core/bookmarks/bookmarks-core";
import { BookmarksService } from "../../core/bookmarks/bookmarks.service";
import { DocumentService } from "../../core/file/document.service";
import { SearchService } from "../../core/index/search.service";
import { ShellService } from "../../core/shell/shell.service";
import { BookmarksComponent, bookmarkRows } from "./bookmarks.component";

describe("bookmarkRows", () => {
  it("lists notes, headings, searches and groups with depth and kind", () => {
    const items: Bookmark[] = [
      { type: "file", path: "a.md" },
      {
        type: "group",
        title: "G",
        items: [
          { type: "file", path: "b.md", subpath: "#H" },
          { type: "search", query: "q" },
        ],
      },
      { type: "graph" },
    ];
    expect(bookmarkRows(items).map((r) => [r.path.join("."), r.depth, r.kind])).toEqual([
      ["0", 0, "note"],
      ["1", 0, "group"],
      ["1.0", 1, "heading"],
      ["1.1", 1, "search"],
      ["2", 0, "other"],
    ]);
  });
});

describe("BookmarksComponent", () => {
  beforeAll(() => {
    TestBed.initTestEnvironment(BrowserTestingModule, platformBrowserTesting());
  });

  function render(openPath: string | null) {
    const open = vi.fn().mockResolvedValue(undefined);
    const items: Bookmark[] = [
      { type: "file", path: "a.md" },
      { type: "file", path: "b.md", subpath: "#H" },
      { type: "file", path: "b.md" },
    ];
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        {
          provide: BookmarksService,
          useValue: {
            items: signal(items),
            notice: signal(null),
            open,
            relative: (p: string | null) => (p ? p.slice("/vault/".length) : null),
          },
        },
        { provide: DocumentService, useValue: { path: signal(openPath) } },
        { provide: SearchService, useValue: {} },
        { provide: ShellService, useValue: {} },
      ],
    });
    const fixture = TestBed.createComponent(BookmarksComponent);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    return { open, items, rows: el.querySelectorAll<HTMLButtonElement>("button[hx-list-row]") };
  }

  it("marks the bookmark of the open note as current, not one of a heading in it", () => {
    const { rows } = render("/vault/b.md");
    expect([...rows].map((r) => r.getAttribute("aria-current"))).toEqual([null, null, "true"]);
  });

  it("opens a bookmark on click and moves through the rows with the arrows", () => {
    const { rows, open, items } = render(null);
    expect([...rows].some((r) => r.hasAttribute("aria-current"))).toBe(false);
    rows[1].click();
    expect(open).toHaveBeenCalledWith(items[1], expect.any(Function), false);
    rows[0].focus();
    pressArrow(rows[0], "ArrowDown");
    expect(document.activeElement).toBe(rows[1]);
  });
});

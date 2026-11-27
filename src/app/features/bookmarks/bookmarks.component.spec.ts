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

  const files: Bookmark[] = [
    { type: "file", path: "a.md" },
    { type: "file", path: "b.md", subpath: "#H" },
    { type: "file", path: "b.md" },
  ];

  function render(openPath: string | null, items: Bookmark[] = files) {
    const open = vi.fn().mockResolvedValue(undefined);
    const addGroup = vi.fn();
    const remove = vi.fn();
    const renameGroup = vi.fn();
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        {
          provide: BookmarksService,
          useValue: {
            items: signal(items),
            notice: signal(null),
            open,
            addGroup,
            remove,
            renameGroup,
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
    const tick = () => {
      TestBed.tick();
      fixture.detectChanges();
    };
    const rows = el.querySelectorAll<HTMLButtonElement>("button[hx-list-row]");
    return { el, tick, open, items, rows, addGroup, remove, renameGroup };
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

  it("adds a group and removes a bookmark with their buttons", () => {
    const { el, addGroup, remove, open } = render(null);
    el.querySelector<HTMLButtonElement>("button[aria-label='New group']")!.click();
    expect(addGroup).toHaveBeenCalledTimes(1);
    const removes = el.querySelectorAll<HTMLButtonElement>("button[aria-label='Remove bookmark']");
    expect(removes).toHaveLength(3);
    removes[1].click();
    expect(remove).toHaveBeenCalledWith([1]);
    expect(open).not.toHaveBeenCalled();
  });

  describe("renaming a group", () => {
    const group: Bookmark[] = [{ type: "group", title: "Old", items: [] }];

    function startRename() {
      const view = render(null, group);
      view.rows[0].dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
      view.tick();
      const input = view.el.querySelector<HTMLInputElement>("input[aria-label='Group name']")!;
      expect(input.value).toBe("Old");
      const key = (name: string) => {
        input.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true }));
        view.tick();
      };
      return { ...view, input, key };
    }

    it("saves the name with Enter, once", () => {
      const { el, input, key, renameGroup } = startRename();
      input.value = "New";
      key("Enter");
      input.dispatchEvent(new FocusEvent("blur"));
      expect(renameGroup).toHaveBeenCalledTimes(1);
      expect(renameGroup).toHaveBeenCalledWith([0], "New");
      expect(el.querySelector("input")).toBeNull();
    });

    it("saves the name when the field loses the focus", () => {
      const { input, renameGroup } = startRename();
      input.value = "New";
      input.dispatchEvent(new FocusEvent("blur"));
      expect(renameGroup).toHaveBeenCalledWith([0], "New");
    });

    it("keeps the old name on Escape and for a blank name", () => {
      const escaped = startRename();
      escaped.input.value = "New";
      escaped.key("Escape");
      expect(escaped.el.querySelector("input")).toBeNull();
      expect(escaped.renameGroup).not.toHaveBeenCalled();
      const blank = startRename();
      blank.input.value = "  ";
      blank.key("Enter");
      expect(blank.renameGroup).not.toHaveBeenCalled();
    });
  });
});

// @vitest-environment jsdom
import "@angular/compiler";
import { readFileSync } from "node:fs";
import { ApplicationRef, signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { BrowserTestingModule, platformBrowserTesting } from "@angular/platform-browser/testing";
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

import { BookmarksService } from "../../core/bookmarks/bookmarks.service";
import type { SearchHit } from "../../core/file/backend";
import { DocumentService } from "../../core/file/document.service";
import { TabsService } from "../../core/tabs/tabs.service";
import { ReplaceService } from "../../core/index/replace.service";
import type { SearchState } from "../../core/index/search.service";
import { SearchService, segments } from "../../core/index/search.service";
import { WorkspaceService } from "../../core/workspace/workspace.service";
import { WorkspacesService } from "../../core/workspace/workspaces.service";
import { SearchComponent } from "./search.component";
import { pressArrow } from "../../../testing/list-keys";

const hit: SearchHit = {
  path: "work/b.md",
  title: "b",
  modified: 100,
  matches: 5,
  snippets: [
    { line: 4, text: "a \u0001quick\u0002 note" },
    { line: 9, text: "\u0001quick\u0002ly" },
  ],
};

function replaceMock(enabled: boolean, notes: unknown[] = []) {
  return {
    enabled: signal(enabled),
    replacement: signal(""),
    regex: signal(false),
    caseSensitive: signal(false),
    wholeWord: signal(false),
    notes: signal(notes),
    error: signal<string | null>(null),
    busy: signal(false),
    totals: signal({ notes: notes.length, replacements: notes.length }),
    isNoteExcluded: vi.fn().mockReturnValue(false),
    isMatchExcluded: vi.fn().mockReturnValue(false),
    toggleNote: vi.fn(),
    toggleMatch: vi.fn(),
    toggle: vi.fn(),
    refresh: vi.fn(),
    apply: vi.fn().mockResolvedValue(null),
  };
}

function tick(): void {
  TestBed.inject(ApplicationRef).tick();
}

function render(
  state: SearchState,
  hits: SearchHit[],
  replace = replaceMock(false),
  roots: { path: string; name: string }[] | null = null,
  openPath: string | null = null,
) {
  const open = vi.fn().mockResolvedValue(undefined);
  const openPinned = vi.fn().mockResolvedValue(undefined);
  const setQuery = vi.fn();
  const close = vi.fn();
  const bookmarkSearch = vi.fn();
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      {
        provide: SearchService,
        useValue: {
          state: signal(state),
          hits: signal(hits),
          query: signal("quick"),
          visible: signal(true),
          key: signal("k"),
          refresh: vi.fn(),
          setQuery,
          close,
        },
      },
      { provide: ReplaceService, useValue: replace },
      { provide: DocumentService, useValue: { path: signal(openPath) } },
      { provide: TabsService, useValue: { openPreview: open, openPinned } },
      { provide: BookmarksService, useValue: { bookmarkSearch } },
      { provide: WorkspaceService, useValue: { vaultRoot: signal("/vault") } },
      { provide: WorkspacesService, useValue: { searchRoots: signal(roots) } },
    ],
  });
  TestBed.overrideComponent(SearchComponent, {
    set: {
      templateUrl: undefined,
      styleUrl: undefined,
      template: readFileSync("src/app/features/search/search.component.html", "utf8"),
    },
  });
  const fixture = TestBed.createComponent(SearchComponent);
  fixture.detectChanges();
  return {
    el: fixture.nativeElement as HTMLElement,
    open,
    openPinned,
    setQuery,
    close,
    bookmarkSearch,
  };
}

describe("SearchComponent", () => {
  beforeAll(() => {
    TestBed.initTestEnvironment(BrowserTestingModule, platformBrowserTesting());
  });

  it("groups snippets under their note and highlights the matches", () => {
    const { el } = render("ready", [hit]);
    expect(el.querySelectorAll(".hit").length).toBe(1);
    expect(el.querySelector(".name")?.textContent).toContain("b");
    expect([...el.querySelectorAll("mark")].map((m) => m.textContent)).toEqual(["quick", "quick"]);
    expect(segments("x")[0].match).toBe(false);
  });

  it("opens the note at the line of the clicked snippet, or at the top from its title", () => {
    const { el, open } = render("ready", [hit]);
    const snippets = el.querySelectorAll<HTMLButtonElement>("button.snippet");
    snippets[1].click();
    expect(open).toHaveBeenLastCalledWith("/vault/work/b.md", { line: 9 });
    el.querySelector<HTMLButtonElement>("button.note")!.click();
    expect(open).toHaveBeenLastCalledWith("/vault/work/b.md", { line: null });
  });

  it("a double click on a result keeps the note in a tab of its own", () => {
    const { el, openPinned } = render("ready", [hit]);
    el.querySelectorAll("button.snippet")[1].dispatchEvent(
      new MouseEvent("dblclick", { bubbles: true }),
    );
    expect(openPinned).toHaveBeenLastCalledWith("/vault/work/b.md", { line: 9 });
    el.querySelector("button.note")!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    expect(openPinned).toHaveBeenLastCalledWith("/vault/work/b.md", { line: null });
  });

  it("marks the result of the open note as current", () => {
    const a: SearchHit = { path: "a.md", title: "a", modified: 1, matches: 0, snippets: [] };
    const { el } = render("ready", [hit, a], undefined, null, "/vault/a.md");
    const notes = el.querySelectorAll("button.note");
    expect(notes[0].getAttribute("aria-current")).toBeNull();
    expect(notes[1].getAttribute("aria-current")).toBe("true");
    expect(notes[1].classList.contains("hx-list-row-current")).toBe(true);
  });

  it("moves through the results and their snippets with the arrows", () => {
    const { el } = render("ready", [hit]);
    const rows = el.querySelectorAll<HTMLButtonElement>("button[hx-list-row]");
    expect(rows).toHaveLength(4);
    rows[0].focus();
    pressArrow(rows[0], "ArrowDown");
    expect(document.activeElement).toBe(rows[1]);
    pressArrow(rows[1], "ArrowDown");
    expect(document.activeElement).toBe(el.querySelectorAll("button.snippet")[0]);
  });

  it("counts the results and the notes above the list", () => {
    const other: SearchHit = {
      path: "a.md",
      title: "a",
      modified: 200,
      matches: 1,
      snippets: [{ line: 1, text: "\u0001quick\u0002" }],
    };
    expect(render("ready", [hit, other]).el.querySelector(".count")?.textContent).toBe(
      "6 results in 2 notes",
    );
    expect(render("ready", [other]).el.querySelector(".count")?.textContent).toBe(
      "1 result in 1 note",
    );
  });

  it("sorts by relevance, name or modified time and keeps the choice", () => {
    localStorage.clear();
    const a: SearchHit = { path: "z/a.md", title: "a", modified: 50, matches: 0, snippets: [] };
    const { el } = render("ready", [hit, a]);
    const names = () =>
      [...el.querySelectorAll("button.note .name")].map((n) => n.textContent?.trim());
    expect(names()).toEqual(["b", "a"]);
    const select = el.querySelector<HTMLSelectElement>("select.sort")!;
    select.value = "name";
    select.dispatchEvent(new Event("change"));
    tick();
    expect(names()).toEqual(["a", "b"]);
    expect(localStorage.getItem("nixe.search.sort")).toBe("name");
    select.value = "modified";
    select.dispatchEvent(new Event("change"));
    tick();
    expect(names()).toEqual(["b", "a"]);
    // a new panel starts with the stored choice
    const again = render("ready", [hit, a]).el;
    expect(again.querySelector<HTMLSelectElement>("select.sort")!.value).toBe("modified");
    localStorage.clear();
  });

  it("collapses the snippets of one note and of all notes", () => {
    const { el } = render("ready", [hit]);
    expect(el.querySelectorAll("button.snippet").length).toBe(2);
    el.querySelector<HTMLButtonElement>("button.fold")!.click();
    tick();
    expect(el.querySelectorAll("button.snippet").length).toBe(0);
    el.querySelector<HTMLButtonElement>("button.fold")!.click();
    tick();
    expect(el.querySelectorAll("button.snippet").length).toBe(2);
    el.querySelector<HTMLButtonElement>("button.collapse-all")!.click();
    tick();
    expect(el.querySelectorAll("button.snippet").length).toBe(0);
    expect(el.querySelector("button.collapse-all")?.getAttribute("aria-label")).toBe("Expand all");
    el.querySelector<HTMLButtonElement>("button.collapse-all")!.click();
    tick();
    expect(el.querySelectorAll("button.snippet").length).toBe(2);
  });

  it("lists the operators in a help and inserts the clicked one into the query", () => {
    const { el, setQuery } = render("ready", []);
    expect(el.querySelector(".operators")).toBeNull();
    el.querySelector<HTMLButtonElement>("button.help")!.click();
    tick();
    const ops = [...el.querySelectorAll<HTMLButtonElement>("button.operator")];
    expect(ops.map((o) => o.querySelector("code")?.textContent)).toEqual(["tag:#", "path:", '""']);
    ops[1].click();
    expect(setQuery).toHaveBeenCalledWith("quick path:");
  });

  it("bookmarks the search with the star", () => {
    const { el, bookmarkSearch } = render("ready", []);
    el.querySelector<HTMLButtonElement>("button.bookmark")!.click();
    expect(bookmarkSearch).toHaveBeenCalled();
  });

  it("forwards typing to the search", () => {
    const { el, setQuery } = render("ready", []);
    const input = el.querySelector("input")!;
    input.value = "tag:#x";
    input.dispatchEvent(new Event("input"));
    expect(setQuery).toHaveBeenCalledWith("tag:#x");
  });

  it("says so when nothing matches, while indexing and when the index failed", () => {
    expect(render("ready", []).el.textContent).toContain("No results");
    expect(render("loading", []).el.textContent).toContain("Indexing the vault");
    expect(render("error", []).el.textContent).toContain("not available");
  });

  it("shows the replace field and the diff of each replacement", () => {
    const replace = replaceMock(true, [
      {
        path: "a.md",
        count: 1,
        replacements: [{ index: 0, line: 3, before: "old", after: "new" }],
      },
    ]);
    const { el } = render("ready", [hit], replace);
    expect(el.querySelector("input.replacement")).not.toBeNull();
    expect(el.querySelector("del")?.textContent).toBe("old");
    expect(el.querySelector("ins")?.textContent).toBe("new");
    expect(el.querySelector("button.apply")?.textContent).toContain("Replace 1 in 1 note");
    expect(el.querySelector("button.snippet")).toBeNull();
    expect(replace.refresh).toHaveBeenCalledWith("quick");
  });

  it("excludes a note or a single match with its checkbox and applies with the button", () => {
    const replace = replaceMock(true, [
      {
        path: "a.md",
        count: 1,
        replacements: [{ index: 0, line: 3, before: "old", after: "new" }],
      },
    ]);
    const { el } = render("ready", [], replace);
    el.querySelector<HTMLInputElement>(".note-row input")!.click();
    expect(replace.toggleNote).toHaveBeenCalledWith("a.md");
    el.querySelector<HTMLInputElement>(".diff input")!.click();
    expect(replace.toggleMatch).toHaveBeenCalledWith("a.md", 0);
    el.querySelector<HTMLButtonElement>("button.apply")!.click();
    expect(replace.apply).toHaveBeenCalledWith("quick");
  });

  it("types the replacement into the service and toggles the replace mode", () => {
    const replace = replaceMock(true);
    const { el } = render("ready", [], replace);
    const field = el.querySelector<HTMLInputElement>("input.replacement")!;
    field.value = "x";
    field.dispatchEvent(new Event("input"));
    expect(replace.replacement()).toBe("x");
    el.querySelector<HTMLButtonElement>("button.toggle-replace")!.click();
    expect(replace.toggle).toHaveBeenCalled();
  });

  describe("over a workspace (#117)", () => {
    const roots = [
      { path: "/vault", name: "Notes" },
      { path: "/wiki", name: "Wiki" },
    ];
    const wikiHit: SearchHit = { ...hit, root: "Wiki", rootPath: "/wiki" };

    it("shows the root of each result and opens the note in that root", () => {
      const { el, open } = render("ready", [wikiHit], replaceMock(false), roots);
      expect(el.querySelector("button.note .root")?.textContent).toBe("Wiki");
      el.querySelector<HTMLButtonElement>("button.snippet")!.click();
      expect(open).toHaveBeenLastCalledWith("/wiki/work/b.md", { line: 4 });
    });

    it("keeps two notes with the same path of different roots apart", () => {
      const other: SearchHit = { ...hit, root: "Notes", rootPath: "/vault" };
      const { el } = render("ready", [wikiHit, other], replaceMock(false), roots);
      expect(el.querySelectorAll("button.note").length).toBe(2);
      el.querySelector<HTMLButtonElement>("button.fold")!.click();
      tick();
      expect(el.querySelectorAll("button.snippet").length).toBe(2);
    });

    it("offers the root: operator only while the workspace has several folders", () => {
      const withRoots = render("ready", [hit], replaceMock(false), roots);
      withRoots.el.querySelector<HTMLButtonElement>("button.help")!.click();
      tick();
      expect(
        [...withRoots.el.querySelectorAll(".operator code")].map((c) => c.textContent),
      ).toContain("root:");
      const single = render("ready", [hit]);
      single.el.querySelector<HTMLButtonElement>("button.help")!.click();
      tick();
      expect(
        [...single.el.querySelectorAll(".operator code")].map((c) => c.textContent),
      ).not.toContain("root:");
      expect(single.el.querySelector("button.note .root")).toBeNull();
    });
  });
});

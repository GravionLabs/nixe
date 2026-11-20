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

import { BookmarksService } from "../../core/bookmarks/bookmarks.service";
import { SearchHit } from "../../core/file/backend";
import { DocumentService } from "../../core/file/document.service";
import { ReplaceService } from "../../core/index/replace.service";
import { SearchService, SearchState, segments } from "../../core/index/search.service";
import { WorkspaceService } from "../../core/workspace/workspace.service";
import { SearchComponent } from "./search.component";

const hit: SearchHit = {
  path: "work/b.md",
  title: "b",
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

function render(state: SearchState, hits: SearchHit[], replace = replaceMock(false)) {
  const open = vi.fn().mockResolvedValue(undefined);
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
      { provide: DocumentService, useValue: { open } },
      { provide: BookmarksService, useValue: { bookmarkSearch } },
      { provide: WorkspaceService, useValue: { vaultRoot: signal("/vault") } },
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
  return { el: fixture.nativeElement as HTMLElement, open, setQuery, close, bookmarkSearch };
}

describe("SearchComponent", () => {
  beforeAll(() => {
    TestBed.initTestEnvironment(BrowserTestingModule, platformBrowserTesting());
  });

  it("groups snippets under their note and highlights the matches", () => {
    const { el } = render("ready", [hit]);
    expect(el.querySelectorAll("li").length).toBe(1);
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
      { path: "a.md", count: 1, replacements: [{ index: 0, line: 3, before: "old", after: "new" }] },
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
      { path: "a.md", count: 1, replacements: [{ index: 0, line: 3, before: "old", after: "new" }] },
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
});

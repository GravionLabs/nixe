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

import { SearchHit } from "../../core/file/backend";
import { DocumentService } from "../../core/file/document.service";
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

function render(state: SearchState, hits: SearchHit[]) {
  const open = vi.fn().mockResolvedValue(undefined);
  const setQuery = vi.fn();
  const close = vi.fn();
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
      { provide: DocumentService, useValue: { open } },
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
  return { el: fixture.nativeElement as HTMLElement, open, setQuery, close };
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
});

// @vitest-environment jsdom
import "@angular/compiler";
import { signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { BrowserTestingModule, platformBrowserTesting } from "@angular/platform-browser/testing";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

import { backend } from "../file/backend";
import { IndexService } from "./index.service";
import { SearchService, segments } from "./search.service";

describe("segments", () => {
  it("splits a snippet at the match markers", () => {
    expect(segments("a \u0001b\u0002 c \u0001d\u0002")).toEqual([
      { text: "a ", match: false },
      { text: "b", match: true },
      { text: " c ", match: false },
      { text: "d", match: true },
    ]);
    expect(segments("\u0001x\u0002")).toEqual([{ text: "x", match: true }]);
    expect(segments("plain")).toEqual([{ text: "plain", match: false }]);
  });
});

describe("SearchService", () => {
  const status = signal<{ state: string }>({ state: "ready" });
  let search: SearchService;

  beforeAll(() => {
    TestBed.initTestEnvironment(BrowserTestingModule, platformBrowserTesting());
  });

  beforeEach(() => {
    status.set({ state: "ready" });
    vi.restoreAllMocks();
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [{ provide: IndexService, useValue: { status, revision: signal(0) } }],
    });
    search = TestBed.inject(SearchService);
  });

  it("opens with a query and searches the index", async () => {
    const hits = [{ path: "a.md", title: "a", snippets: [] }];
    const spy = vi.spyOn(backend, "searchNotes").mockResolvedValue(hits);
    search.openWith("tag:#work");
    await vi.waitFor(() => expect(search.hits()).toEqual(hits));
    expect(spy).toHaveBeenCalledWith("tag:#work");
    expect(search.visible()).toBe(true);
    expect(search.state()).toBe("ready");
  });

  it("does not search an empty query or while the index is building", async () => {
    const spy = vi.spyOn(backend, "searchNotes").mockResolvedValue([]);
    await search.setQuery("   ");
    expect(search.state()).toBe("idle");
    status.set({ state: "scanning" });
    await search.setQuery("x");
    expect(search.state()).toBe("loading");
    expect(spy).not.toHaveBeenCalled();
  });

  it("lets the newest query win and reports failures", async () => {
    let first!: (h: never[]) => void;
    vi.spyOn(backend, "searchNotes")
      .mockImplementationOnce(() => new Promise((r) => (first = r)))
      .mockResolvedValueOnce([{ path: "new.md", title: "new", snippets: [] }]);
    const slow = search.setQuery("one");
    await search.setQuery("two");
    first([]);
    await slow;
    expect(search.hits().map((h) => h.path)).toEqual(["new.md"]);

    vi.spyOn(backend, "searchNotes").mockRejectedValue("boom");
    await search.setQuery("three");
    expect(search.state()).toBe("error");
  });
});

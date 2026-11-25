// @vitest-environment jsdom
import "@angular/compiler";
import { readFileSync } from "node:fs";
import { signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { BrowserTestingModule, platformBrowserTesting } from "@angular/platform-browser/testing";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  convertFileSrc: (path: string) => `asset://${path}`,
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { BaseResult, BaseSort, BaseView, IndexStatus } from "../../core/file/backend";
import { IndexService } from "../../core/index/index.service";
import { SettingsService } from "../../core/settings/settings.service";
import type { BaseChoice } from "../../core/tabs/tabs.service";
import { CURRENT_TAB, TabsService } from "../../core/tabs/tabs.service";
import { WorkspaceService } from "../../core/workspace/workspace.service";
import { BaseComponent } from "./base.component";

const invokeMock = vi.mocked(invoke);

const table = (name: string, unsupported: string[] = []): BaseResult => ({
  view: "All",
  columns: [
    { id: "file.name", label: "file.name" },
    { id: "count", label: "Count" },
    { id: "done", label: "done" },
    { id: "tags", label: "tags" },
  ],
  rows: [
    {
      path: `sub/${name}.md`,
      cover: null,
      cells: [
        { type: "text", value: name },
        { type: "number", value: 3 },
        { type: "checkbox", value: true },
        { type: "list", value: ["a", "b"] },
      ],
    },
    {
      path: "Empty.md",
      cover: null,
      cells: [
        { type: "text", value: "Empty" },
        { type: null, value: null },
        { type: null, value: null },
        { type: null, value: null },
      ],
    },
  ],
  grouping: null,
  cards: null,
  unsupported,
});

type Query = (source: string, view: number | null, sort: BaseSort | null) => Promise<BaseResult>;

const ONE_VIEW: BaseView[] = [{ name: "All", type: "table" }];

/** The fake backend: `.base` files by path, and what `base_query` answers. */
function fakeBackend(query: Query, views: () => BaseView[] = () => ONE_VIEW) {
  invokeMock.mockImplementation(async (command: string, args?: unknown) => {
    const a = args as Record<string, string>;
    if (command === "read_text_file") return `source of ${a["path"]}`;
    if (command === "base_views") return views();
    if (command === "base_query") {
      const { source, view, sort } = args as {
        source: string;
        view: number | null;
        sort: BaseSort | null;
      };
      return query(source, view, sort);
    }
    return undefined;
  });
}

function status(state: string): IndexStatus {
  return { state, done: 0, total: 0, notes: 0, error: null } as IndexStatus;
}

function render(previewTabs = true) {
  const base = signal<string | null>("/vault/Library.base");
  const baseChoice = signal<BaseChoice>({ view: null, sort: null });
  const index = { status: signal(status("ready")), revision: signal(0) };
  const tabs = {
    notice: signal<string | null>(null),
    openPreview: vi.fn().mockResolvedValue(undefined),
    openInNewTab: vi.fn().mockResolvedValue(undefined),
  };
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      { provide: CURRENT_TAB, useValue: { base, baseChoice } },
      { provide: IndexService, useValue: index },
      { provide: SettingsService, useValue: { previewTabs: signal(previewTabs) } },
      { provide: TabsService, useValue: tabs },
      { provide: WorkspaceService, useValue: { vaultRoot: signal("/vault") } },
    ],
  });
  TestBed.overrideComponent(BaseComponent, {
    set: {
      templateUrl: undefined,
      styleUrl: undefined,
      template: readFileSync("src/app/features/bases/base.component.html", "utf8"),
    },
  });
  const fixture = TestBed.createComponent(BaseComponent);
  const el = fixture.nativeElement as HTMLElement;
  const settle = async () => {
    for (let i = 0; i < 3; i++) {
      fixture.detectChanges();
      await new Promise((resolve) => setTimeout(resolve));
    }
    fixture.detectChanges();
  };
  const cells = () =>
    [...el.querySelectorAll("tbody tr")].map((tr) =>
      [...tr.querySelectorAll("td")].map((td) => td.textContent!.trim()),
    );
  const alert = () => el.querySelector('[role="alert"]')?.textContent?.trim() ?? null;
  return { base, baseChoice, index, tabs, el, fixture, settle, cells, alert };
}

describe("BaseComponent", () => {
  beforeAll(() => {
    TestBed.initTestEnvironment(BrowserTestingModule, platformBrowserTesting());
  });
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("shows the table of the file: headers, typed values, no message", async () => {
    fakeBackend(async () => table("Dune"));
    const view = render();
    await view.settle();

    expect(invokeMock).toHaveBeenCalledWith("base_query", {
      source: "source of /vault/Library.base",
      view: 0,
      sort: null,
    });
    const headers = [...view.el.querySelectorAll("thead th")].map((th) => th.textContent!.trim());
    expect(headers).toEqual(["file.name", "Count", "done", "tags"]);
    expect(view.cells()).toEqual([
      ["Dune", "3", "", "a, b"],
      ["Empty", "", "", ""],
    ]);
    const boxes = view.el.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
    expect(boxes.length).toBe(1);
    expect(boxes[0]!.checked).toBe(true);
    expect(view.el.querySelector('[role="status"]')).toBeNull();
  });

  it("names the unsupported parts", async () => {
    fakeBackend(async () => table("Dune", ["filters", "formulas"]));
    const view = render();
    await view.settle();

    expect(view.el.querySelector('[role="status"]')?.textContent?.trim()).toBe(
      "Not supported yet, so not applied: filters, formulas.",
    );
  });

  it("opens the note of a row on a click on its name, keeping the table", async () => {
    fakeBackend(async () => table("Dune"));
    const view = render();
    await view.settle();

    view.el.querySelector<HTMLButtonElement>("button.note-link")!.click();
    expect(view.tabs.openPreview).toHaveBeenCalledWith("/vault/sub/Dune.md");

    const off = render(false);
    await off.settle();
    off.tabs.openInNewTab.mockRejectedValue("gone");
    off.el.querySelector<HTMLButtonElement>("button.note-link")!.click();
    // Opening shows another tab, which destroys the table before the note was read.
    off.fixture.destroy();
    await new Promise((resolve) => setTimeout(resolve));
    expect(off.tabs.openInNewTab).toHaveBeenCalledWith("/vault/sub/Dune.md");
    expect(off.tabs.notice()).toBe("gone");
  });

  it("does not list the vault's notes for a base outside the vault", async () => {
    fakeBackend(async () => table("Dune"));
    const view = render();
    view.base.set("/vault-other/Library.base");
    await view.settle();

    expect(view.alert()).toBe("Bases outside the open vault are not supported yet.");
    expect(view.el.querySelector("table")).toBeNull();
  });

  it("reads the file again after a vault change", async () => {
    let name = "Dune";
    fakeBackend(async () => table(name));
    const view = render();
    await view.settle();

    name = "Emma";
    view.index.revision.set(1);
    await view.settle();

    expect(view.cells()[0]![0]).toBe("Emma");
  });

  it("waits for the index and reports an index that failed", async () => {
    fakeBackend(async () => table("Dune"));
    const view = render();
    view.index.status.set(status("scanning"));
    await view.settle();
    expect(view.el.textContent).toContain("Loading…");
    expect(invokeMock).not.toHaveBeenCalledWith("base_query", expect.anything());

    view.index.status.set(status("error"));
    await view.settle();
    expect(view.alert()).toBe("The vault index is not available.");

    view.index.status.set(status("ready"));
    await view.settle();
    expect(view.alert()).toBeNull();
    expect(view.cells().length).toBe(2);
  });

  it("shows the message of a failed query instead of the table and logs it", async () => {
    let fail = false;
    fakeBackend(async () => {
      if (fail) throw "Invalid YAML: bad";
      return table("Dune");
    });
    const view = render();
    await view.settle();

    fail = true;
    view.index.revision.set(1);
    await view.settle();

    expect(view.alert()).toBe("Invalid YAML: bad");
    expect(view.el.querySelector("table")).toBeNull();
    expect(invokeMock).toHaveBeenCalledWith("log_command_error", {
      command: "base_query",
      error: "Invalid YAML: bad",
    });
  });

  it.each(["answer", "failure"])(
    "ignores the late %s of an older query after a vault change",
    async (kind) => {
      let settleOld!: () => void;
      let queries = 0;
      fakeBackend((_source) => {
        if (++queries > 1) return Promise.resolve(table("New"));
        return new Promise((resolve, reject) => {
          settleOld = () => (kind === "answer" ? resolve(table("Old")) : reject("old failure"));
        });
      });
      const view = render();
      await view.settle();

      view.index.revision.set(1);
      await view.settle();
      settleOld();
      await view.settle();

      expect(view.cells()[0]![0]).toBe("New");
      expect(view.alert()).toBeNull();
    },
  );

  it("never shows the table of the previous file after the file switched", async () => {
    let settleOld!: () => void;
    fakeBackend((source) => {
      if (source.endsWith("Other.base")) return Promise.resolve(table("Other"));
      return new Promise((resolve) => {
        settleOld = () => resolve(table("Old"));
      });
    });
    const view = render();
    await view.settle();

    view.base.set("/vault/Other.base");
    await view.settle();
    settleOld();
    await view.settle();

    expect(view.cells()[0]![0]).toBe("Other");
    expect(view.el.querySelector("header")?.textContent).toContain("Other.base");
  });
});

describe("BaseComponent formula cells", () => {
  const link = (text: string, path: string | null, url: string | null = null) => ({
    type: "link" as const,
    value: { text, path, url },
  });
  const formulas: BaseResult = {
    view: null,
    columns: ["a", "b", "c", "d", "e"].map((n) => ({ id: `formula.${n}`, label: n })),
    rows: [
      {
        path: "Row.md",
        cells: [
          { type: "error", value: "unknown formula `x`" },
          link("Emma", "books/Emma.md"),
          link("Site", null, "https://example.org"),
          link("Cover", "cover.png"),
          link("Ghost", null),
        ],
      },
    ],
    grouping: null,
    unsupported: [],
  };

  async function shown() {
    fakeBackend(async () => formulas);
    const view = render();
    await view.settle();
    const buttons = [...view.el.querySelectorAll<HTMLButtonElement>("tbody button")];
    return { ...view, buttons };
  }

  beforeEach(() => {
    vi.mocked(openUrl).mockReset().mockResolvedValue(undefined);
  });

  it("shows the error of a cell in that cell and the other cells beside it", async () => {
    const view = await shown();
    expect(view.cells()).toEqual([
      ["Error: unknown formula `x`", "Emma", "Site", "Cover", "Ghost"],
    ]);
    expect(view.alert()).toBeNull();
  });

  it("opens the note and the address of a link; other links are text", async () => {
    const view = await shown();
    expect(view.buttons.map((b) => b.textContent!.trim())).toEqual(["Emma", "Site"]);
    view.buttons[0]!.click();
    await view.settle();
    expect(view.tabs.openPreview).toHaveBeenCalledWith("/vault/books/Emma.md");
    view.buttons[1]!.click();
    await view.settle();
    expect(openUrl).toHaveBeenCalledWith("https://example.org");
  });

  it("shows a notice when an address cannot be opened", async () => {
    vi.mocked(openUrl).mockRejectedValue("not allowed");
    const view = await shown();
    view.buttons[1]!.click();
    await view.settle();
    expect(view.tabs.notice()).toBe("not allowed");
  });
});

describe("BaseComponent views", () => {
  const VIEWS: BaseView[] = [
    { name: "Board", type: "cards" },
    { name: "All", type: "table" },
    { name: null, type: "table" },
  ];
  /** The queries as `[view, sort]`. */
  let queries: [number | null, BaseSort | null][];

  async function shown(views: () => BaseView[] = () => VIEWS) {
    queries = [];
    fakeBackend(async (_source, view, sort) => {
      queries.push([view, sort]);
      if (view === 0) throw 'Views of type "cards" are not supported yet; only "table" is.';
      return table(`View ${view}`);
    }, views);
    const view = render();
    await view.settle();
    const switcher = () => [
      ...view.el.querySelectorAll<HTMLButtonElement>("hx-select-button button"),
    ];
    const choose = async (label: string) => {
      switcher()
        .find((b) => b.textContent!.trim() === label)!
        .click();
      await view.settle();
    };
    const headers = () => [...view.el.querySelectorAll<HTMLElement>("thead th")];
    const sort = async (column: number) => {
      headers()[column]!.querySelector("button")!.click();
      await view.settle();
    };
    return { ...view, switcher, choose, headers, sort };
  }

  it("lists the views by name and shows the first table view", async () => {
    const view = await shown();
    expect(view.switcher().map((b) => b.textContent!.trim())).toEqual(["Board", "All", "View 3"]);
    expect(queries).toEqual([[1, null]]);
    expect(view.cells()[0]![0]).toBe("View 1");
  });

  it("shows the chosen view and keeps the switcher when it cannot be shown", async () => {
    const view = await shown();
    await view.choose("View 3");
    expect(view.cells()[0]![0]).toBe("View 2");

    await view.choose("Board");
    expect(view.alert()).toContain("not supported yet");
    expect(view.el.querySelector("table")).toBeNull();

    await view.choose("All");
    expect(view.cells()[0]![0]).toBe("View 1");
    expect(view.baseChoice().view).toEqual({ index: 1, name: "All" });
  });

  it("follows the chosen view when the file moves it, and falls back when it is gone", async () => {
    let views = VIEWS;
    const view = await shown(() => views);
    // A click on the default view alone is no choice.
    await view.choose("View 3");
    await view.choose("All");

    views = [VIEWS[2]!, VIEWS[0]!, VIEWS[1]!];
    view.index.revision.set(1);
    await view.settle();
    expect(queries.at(-1)).toEqual([2, null]);

    await view.sort(0);
    views = [VIEWS[0]!, VIEWS[2]!];
    view.index.revision.set(2);
    await view.settle();
    expect(queries.at(-1)).toEqual([1, null]);
    expect(view.baseChoice()).toEqual({ view: null, sort: null });
  });

  it("drops the sort when an unnamed view is gone and another unnamed one shows", async () => {
    let views: BaseView[] = [
      { name: null, type: "table" },
      { name: null, type: "table" },
    ];
    const view = await shown(() => views);
    await view.choose("View 2");
    await view.sort(0);

    views = [views[0]!];
    view.index.revision.set(1);
    await view.settle();

    expect(queries.at(-1)).toEqual([0, null]);
    expect(view.baseChoice()).toEqual({ view: null, sort: null });
  });

  it("sorts by a clicked header for the tab only: ascending, descending, off", async () => {
    const view = await shown();
    await view.sort(1);
    expect(queries.at(-1)).toEqual([1, { property: "count", direction: "ASC" }]);
    expect(view.headers()[1]!.getAttribute("aria-sort")).toBe("ascending");
    await view.sort(1);
    expect(queries.at(-1)).toEqual([1, { property: "count", direction: "DESC" }]);
    expect(view.headers()[1]!.getAttribute("aria-sort")).toBe("descending");
    await view.sort(1);
    expect(queries.at(-1)).toEqual([1, null]);
    expect(view.headers()[1]!.getAttribute("aria-sort")).toBe("none");
    expect(invokeMock).not.toHaveBeenCalledWith("write_text_file", expect.anything());
  });

  it("keeps the view and the sort of the tab, and drops the sort with another view", async () => {
    const view = await shown();
    await view.sort(0);
    const sort = { property: "file.name", direction: "ASC" };
    // The tab is shown again: a new component reads the choice of the tab.
    view.fixture.destroy();
    queries.length = 0;
    const again = TestBed.createComponent(BaseComponent);
    again.detectChanges();
    for (let i = 0; i < 3; i++) await new Promise((resolve) => setTimeout(resolve));
    expect(queries.at(-1)).toEqual([1, sort]);
    again.destroy();

    const other = await shown();
    await other.sort(0);
    await other.choose("View 3");
    expect(queries.at(-1)).toEqual([2, null]);
  });

  it("heads each group with its value and number of rows", async () => {
    const grouped: BaseResult = {
      ...table("Dune"),
      grouping: {
        label: "State",
        groups: [
          { value: { type: "text", value: "read" }, rows: 1 },
          { value: { type: "text", value: "wish" }, rows: 0 },
          { value: { type: null, value: null }, rows: 1 },
        ],
      },
    };
    fakeBackend(async () => grouped);
    const view = render();
    await view.settle();

    expect(view.cells().map((row) => row[0]?.replace(/\s+/g, " "))).toEqual([
      undefined,
      "Dune",
      undefined,
      undefined,
      "Empty",
    ]);
    const headings = [...view.el.querySelectorAll("tbody th")].map((th) =>
      th.textContent!.replace(/\s+/g, " ").trim(),
    );
    expect(headings).toEqual(["State: read 1", "State: wish 0", "State: No value 1"]);
    expect(view.el.querySelector("tbody th")!.getAttribute("colspan")).toBe("4");
  });
});

describe("BaseComponent cards", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  const gallery = (image = true): BaseResult => ({
    view: "Gallery",
    columns: [
      { id: "file.name", label: "file.name" },
      { id: "author", label: "Author" },
      { id: "source", label: "Source" },
    ],
    rows: [
      { path: "books/Dune.md", cover: { type: "path", value: "art/dune.png" } },
      { path: "books/Emma.md", cover: { type: "url", value: "https://example.com/e.png" } },
      { path: "Red.md", cover: { type: "color", value: "#ff0000" } },
      { path: "None.md", cover: null },
    ].map(({ path, cover }) => ({
      path,
      cover: cover as BaseResult["rows"][number]["cover"],
      cells: [
        { type: "text", value: path },
        { type: "text", value: "Herbert" },
        {
          type: "link",
          value: { text: "web", path: null, url: "https://example.com/source" },
        },
      ],
    })),
    grouping: null,
    cards: { image, imageFit: "contain", imageAspectRatio: 0.5, cardSize: 230 },
    unsupported: [],
  });

  async function shownCards(result: () => BaseResult) {
    fakeBackend(
      async () => result(),
      () => [{ name: "Gallery", type: "cards" }],
    );
    const view = render();
    await view.settle();
    const cards = () => [...view.el.querySelectorAll<HTMLElement>("article.card")];
    const covers = () => cards().map((card) => card.querySelector<HTMLElement>(".cover"));
    return { ...view, cards, covers };
  }

  const text = (el: Element) => el.textContent!.replace(/\s+/g, " ").trim();

  it("shows one card per note with its title and the properties of the view", async () => {
    const view = await shownCards(gallery);

    expect(view.el.querySelector("table")).toBeNull();
    expect(view.cards()).toHaveLength(4);
    const first = view.cards()[0]!;
    expect(text(first.querySelector(".card-title")!)).toBe("Dune");
    expect([...first.querySelectorAll("dt")].map(text)).toEqual(["Author", "Source"]);
    expect([...first.querySelectorAll("dd")].map(text)).toEqual(["Herbert", "web"]);
    const grid = view.el.querySelector<HTMLElement>(".cards")!;
    expect(grid.style.getPropertyValue("--card-size")).toBe("230px");
  });

  it("shows images, colors and the placeholder in covers of the given shape and fit", async () => {
    const view = await shownCards(gallery);
    const [dune, emma, red, none] = view.covers();

    const image = dune!.querySelector("img")!;
    expect(image.getAttribute("src")).toBe("asset:///vault/art/dune.png");
    expect(image.style.objectFit).toBe("contain");
    expect(dune!.style.aspectRatio.replace(/\s/g, "")).toMatch(/^2(\/1)?$/);
    expect(emma!.querySelector("img")!.getAttribute("src")).toBe("https://example.com/e.png");
    expect(red!.querySelector("img")).toBeNull();
    expect(red!.style.backgroundColor).toBe("rgb(255, 0, 0)");
    expect(text(red!)).toBe("");
    expect(none!.querySelector("img")).toBeNull();
    expect(text(none!)).toBe("No image");
  });

  it("leaves a placeholder for an image that cannot be loaded, until the next read", async () => {
    const view = await shownCards(gallery);

    view.covers()[0]!.querySelector("img")!.dispatchEvent(new Event("error"));
    await view.settle();
    expect(view.covers()[0]!.querySelector("img")).toBeNull();
    expect(text(view.covers()[0]!)).toBe("No image");
    expect(view.covers()[1]!.querySelector("img")).not.toBeNull();

    view.index.revision.set(1);
    await view.settle();
    expect(view.covers()[0]!.querySelector("img")).not.toBeNull();
  });

  it("has no cover without an image property", async () => {
    const view = await shownCards(() => gallery(false));
    expect(view.covers()).toEqual([null, null, null, null]);
  });

  it("opens the note on a click on a card and an address on a click on its link", async () => {
    const view = await shownCards(gallery);
    const first = view.cards()[0]!;

    // The title is stretched over the card (CSS).
    first.querySelector<HTMLButtonElement>(".card-title")!.click();
    expect(view.tabs.openPreview).toHaveBeenCalledWith("/vault/books/Dune.md");

    first.querySelector<HTMLButtonElement>("dd button")!.click();
    expect(openUrl).toHaveBeenCalledWith("https://example.com/source");
    expect(view.tabs.openPreview).toHaveBeenCalledTimes(1);
  });

  it("heads the groups of the cards and says when there is no note", async () => {
    const result = gallery();
    let shown: BaseResult = {
      ...result,
      grouping: { label: "State", groups: [{ value: { type: "text", value: "read" }, rows: 4 }] },
    };
    const view = await shownCards(() => shown);
    expect([...view.el.querySelectorAll(".cards > h3")].map(text)).toEqual(["State: read 4"]);

    shown = { ...result, rows: [] };
    view.index.revision.set(1);
    await view.settle();
    expect(view.cards()).toHaveLength(0);
    expect(text(view.el.querySelector(".cards")!)).toBe("No notes");
  });
});

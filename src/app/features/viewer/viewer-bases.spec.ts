// @vitest-environment jsdom
import "@angular/compiler";
import { readFileSync } from "node:fs";
import { Input, ViewChild, signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { BrowserTestingModule, platformBrowserTesting } from "@angular/platform-browser/testing";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  convertFileSrc: (path: string) => `asset://${path}`,
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({
  openPath: vi.fn(),
  openUrl: vi.fn(),
  revealItemInDir: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import type { BaseResult, BaseView, IndexStatus } from "../../core/file/backend";
import { DocumentService } from "../../core/file/document.service";
import { FoldStateService } from "../../core/fold/fold-state.service";
import { IndexService } from "../../core/index/index.service";
import { SearchService } from "../../core/index/search.service";
import { MarkdownService } from "../../core/markdown/markdown.service";
import { OutlineService } from "../../core/outline/outline.service";
import { LinkPreviewService } from "../../core/preview/link-preview.service";
import { SettingsService } from "../../core/settings/settings.service";
import { ShellService } from "../../core/shell/shell.service";
import { TabsService } from "../../core/tabs/tabs.service";
import { VaultOpsService } from "../../core/workspace/vault-ops.service";
import { WorkspaceService } from "../../core/workspace/workspace.service";
import { WorkspacesService } from "../../core/workspace/workspaces.service";
import { BaseCellComponent } from "../bases/base-cell.component";
import { BaseComponent } from "../bases/base.component";
import { ViewerComponent } from "./viewer.component";

const invokeMock = vi.mocked(invoke);

// The specs compile with JIT, which does not register signal inputs and queries: declare the two the
// tests need, as the compiler of the app does.
Input({ isSignal: true } as Input)(ViewerComponent.prototype, "html");
ViewChild("content", { isSignal: true } as ViewChild)(ViewerComponent.prototype, "content");

const VIEWS: BaseView[] = [
  { name: "All", type: "table" },
  { name: "Other", type: "table" },
];

const answer = (title: string): BaseResult => ({
  view: "All",
  columns: [
    { id: "file.name", label: "file.name" },
    { id: "count", label: "Count", property: "count" },
  ],
  rows: [
    {
      path: `${title}.md`,
      cover: null,
      cells: [
        { type: "text", value: title },
        { type: "number", value: 3 },
      ],
    },
  ],
  grouping: null,
  cards: null,
  unsupported: [],
});

interface Query {
  source: string;
  view: number | null;
  thisFile: string | null;
}

const queries = (): Query[] =>
  invokeMock.mock.calls.filter(([c]) => c === "base_query").map(([, a]) => a as unknown as Query);

/** The fake backend: a source with `broken` is invalid YAML. */
function fakeBackend(query: (q: Query) => Promise<BaseResult> = async () => answer("Dune")) {
  invokeMock.mockImplementation(async (command: string, args?: unknown) => {
    const a = args as Record<string, string>;
    if (command === "base_views") {
      if (a["source"]!.includes("broken")) throw "Invalid YAML: broken";
      return VIEWS;
    }
    if (command === "base_query") return query(args as Query);
    if (command === "read_text_file") return "```base\nof: embedded\n```\n";
    return undefined;
  });
}

const NOTE = "```base\nviews: [] # -->\n```\n\ntext\n";

function render(
  text = NOTE,
  path: string | null = "/vault/dir/Home.md",
  files: readonly string[] = ["dir/Home.md", "sub/Embedded.md"],
) {
  const doc = {
    path: signal(path),
    content: signal(text),
    wikiRoot: signal(null),
    pendingAnchor: signal<string | null>(null),
    pendingLine: signal<number | null>(null),
  };
  const vaultFiles = signal<readonly string[]>(files);
  const index = {
    status: signal({ state: "ready" } as IndexStatus),
    revision: signal(0),
  };
  const tabs = { notice: signal<string | null>(null), openPreview: vi.fn() };
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      { provide: DocumentService, useValue: doc },
      { provide: IndexService, useValue: index },
      { provide: TabsService, useValue: tabs },
      {
        provide: WorkspaceService,
        useValue: {
          vaultRoot: signal("/vault"),
          vaultFiles,
        },
      },
      {
        provide: SettingsService,
        useValue: { math: signal(false), zoom: signal(100), previewTabs: signal(true) },
      },
      { provide: OutlineService, useValue: { topLine: signal(null) } },
      { provide: FoldStateService, useValue: { peek: () => [], set: () => undefined } },
      { provide: LinkPreviewService, useValue: {} },
      { provide: ShellService, useValue: {} },
      { provide: SearchService, useValue: {} },
      { provide: VaultOpsService, useValue: {} },
      { provide: WorkspacesService, useValue: {} },
    ],
  });
  TestBed.overrideComponent(ViewerComponent, {
    set: {
      imports: [],
      templateUrl: undefined,
      styleUrl: undefined,
      template: `<article #content class="markdown-body" (click)="onClick($event)"></article>`,
    },
  });
  for (const [component, name] of [
    [BaseComponent, "base"],
    [BaseCellComponent, "base-cell"],
  ] as const) {
    TestBed.overrideComponent(component, {
      set: {
        templateUrl: undefined,
        styleUrl: undefined,
        template: readFileSync(`src/app/features/bases/${name}.component.html`, "utf8"),
      },
    });
  }
  const markdown = TestBed.inject(MarkdownService);
  const html = (source: string) =>
    markdown.renderNote(source, {
      filePath: path,
      wikiRoot: null,
      math: false,
      vaultFiles: files,
      vaultRoot: "/vault",
      bases: true,
    }).body;
  const fixture = TestBed.createComponent(ViewerComponent);
  fixture.componentRef.setInput("html", html(text));
  const el = fixture.nativeElement as HTMLElement;
  const settle = async () => {
    for (let i = 0; i < 6; i++) {
      fixture.detectChanges();
      await new Promise((resolve) => setTimeout(resolve));
    }
    fixture.detectChanges();
  };
  const show = (source: string) => fixture.componentRef.setInput("html", html(source));
  const blocks = () => [...el.querySelectorAll<HTMLElement>(".base-block")];
  return { el, fixture, doc, index, tabs, vaultFiles, settle, show, blocks };
}

describe("ViewerComponent base blocks", () => {
  beforeAll(() => {
    TestBed.initTestEnvironment(BrowserTestingModule, platformBrowserTesting());
  });
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("shows the base of a block with its view switcher, with the note as `this`", async () => {
    fakeBackend();
    const view = render();
    await view.settle();

    const block = view.blocks()[0]!;
    expect(block.textContent).not.toContain("shown in the reading view");
    expect(block.querySelector("tbody")!.textContent).toContain("Dune");
    const buttons = [...block.querySelectorAll<HTMLElement>("header button")];
    expect(buttons.map((b) => b.textContent!.trim())).toEqual(["All", "Other"]);
    expect(queries().at(-1)).toMatchObject({
      source: "views: [] # -->\n",
      view: 0,
      thisFile: "dir/Home.md",
    });
    expect(invokeMock).not.toHaveBeenCalledWith("read_text_file", expect.anything());

    buttons[1]!.click();
    await view.settle();
    expect(queries().at(-1)!.view).toBe(1);

    // A change of the note renders it again: the block keeps its view.
    view.show(`${NOTE}more\n`);
    await view.settle();
    expect(queries().at(-1)!.view).toBe(1);
  });

  it("shows the values without editing them", async () => {
    fakeBackend();
    const view = render();
    await view.settle();

    expect(view.el.querySelector("app-base-cell")).toBeNull();
    expect(view.el.querySelector("tbody")!.textContent).toContain("3");
  });

  it("shows the error of an invalid block in its place, beside the others", async () => {
    fakeBackend();
    const view = render("```base\nbroken\n```\n\n```base\nfine\n```\n");
    await view.settle();

    const [broken, fine] = view.blocks();
    expect(broken!.querySelector('[role="alert"]')!.textContent).toContain("Invalid YAML: broken");
    expect(broken!.querySelector("table")).toBeNull();
    expect(fine!.querySelector("table")).not.toBeNull();
  });

  it("follows changes of the vault", async () => {
    let title = "Dune";
    fakeBackend(async () => answer(title));
    const view = render();
    await view.settle();

    title = "Emma";
    view.index.revision.set(1);
    await view.settle();

    expect(view.blocks()[0]!.querySelector("tbody")!.textContent).toContain("Emma");
  });

  it("destroys the bases of the note before and drops their late answers", async () => {
    let late!: () => void;
    fakeBackend((q) =>
      q.source === "old\n"
        ? new Promise((resolve) => (late = () => resolve(answer("Old"))))
        : Promise.resolve(answer("New")),
    );
    const view = render("```base\nold\n```\n");
    await view.settle();
    const old = view.blocks()[0]!;

    view.doc.path.set("/vault/dir/Next.md");
    view.show("```base\nnew\n```\n");
    await view.settle();
    late();
    view.index.revision.set(1);
    await view.settle();

    expect(old.isConnected).toBe(false);
    expect(old.textContent).not.toContain("Old");
    expect(view.el.textContent).toContain("New");
    expect(queries().filter((q) => q.source === "old\n").length).toBe(1);

    view.fixture.destroy();
    const count = queries().length;
    view.index.revision.set(2);
    await new Promise((resolve) => setTimeout(resolve));
    expect(queries().length).toBe(count);
  });

  it("mounts no base for an embed that is read after the view is gone", async () => {
    fakeBackend();
    const answer = invokeMock.getMockImplementation()!;
    let read!: () => void;
    invokeMock.mockImplementation((command, args) =>
      command === "read_text_file"
        ? new Promise((resolve) => (read = () => resolve("```base\nlate\n```\n")))
        : answer(command, args),
    );
    const view = render("![[Embedded]]\n");
    await view.settle();

    view.fixture.destroy();
    read();
    await new Promise((resolve) => setTimeout(resolve, 20));
    view.index.revision.set(1);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(queries()).toEqual([]);
  });

  it("lets the keys pressed in a base reach the shortcuts of the app", async () => {
    fakeBackend();
    const view = render();
    await view.settle();
    document.body.append(view.el);
    const heard = vi.fn();
    document.addEventListener("keydown", heard);

    view
      .blocks()[0]!
      .querySelector("button")!
      .dispatchEvent(new KeyboardEvent("keydown", { key: "p", ctrlKey: true, bubbles: true }));

    document.removeEventListener("keydown", heard);
    view.el.remove();
    expect(heard).toHaveBeenCalled();
  });

  it("renders the blocks anew for another note with the same text", async () => {
    fakeBackend();
    const view = render();
    await view.settle();

    view.doc.path.set("/vault/dir/Twin.md");
    await view.settle();

    expect(queries().at(-1)!.thisFile).toBe("dir/Twin.md");
    expect(view.blocks()).toHaveLength(1);
  });

  it("keeps the links of an element that shows no base inside the app", async () => {
    fakeBackend();
    const view = render('<div class="base-block"><a href="https://example.com">out</a></div>\n');
    await view.settle();

    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    view.el.querySelector("a")!.dispatchEvent(click);
    await view.settle();

    expect(click.defaultPrevented).toBe(true);
  });

  it("binds `this` of a block in an embedded note to that note", async () => {
    fakeBackend();
    const view = render("![[Embedded]]\n");
    await view.settle();

    expect(queries().at(-1)).toMatchObject({
      source: "of: embedded\n",
      thisFile: "sub/Embedded.md",
    });
  });

  it("says that a block of a note outside the vault is not supported", async () => {
    fakeBackend();
    const view = render(NOTE, "/elsewhere/Home.md");
    await view.settle();

    expect(view.el.querySelector('[role="alert"]')!.textContent).toContain(
      "outside the open vault",
    );
    expect(queries()).toEqual([]);
  });
});

describe("ViewerComponent .base embeds", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  const FILES = ["dir/Home.md", "sub/Embedded.md", "bases/Books.base"];

  /** The fake backend with `.base` files that hold `contents`, by absolute path. */
  function withFiles(contents: Record<string, string>) {
    fakeBackend();
    const fallback = invokeMock.getMockImplementation()!;
    invokeMock.mockImplementation(async (command, args) => {
      const path = (args as { path?: string } | undefined)?.path;
      if (command !== "read_text_file" || !path?.endsWith(".base")) return fallback(command, args);
      if (!(path in contents)) throw `No such file: ${path}`;
      return contents[path];
    });
    return contents;
  }

  const alert = (el: HTMLElement) => el.querySelector('[role="alert"]')?.textContent?.trim();

  it("shows the first view of the file, with the embedding note as `this`", async () => {
    withFiles({ "/vault/bases/Books.base": "books" });
    const view = render("![[Books.base]]\n", "/vault/dir/Home.md", FILES);
    await view.settle();

    expect(view.blocks()[0]!.querySelector("tbody")!.textContent).toContain("Dune");
    expect(view.el.querySelector("app-base-cell")).toBeNull();
    expect(queries().at(-1)).toMatchObject({
      source: "books",
      view: 0,
      thisFile: "dir/Home.md",
    });
  });

  it.each(["Books.base#Other", "bases/books.base#other"])(
    "shows the named view of `![[%s]]` and switches to others",
    async (target) => {
      withFiles({ "/vault/bases/Books.base": "books" });
      const view = render(`![[${target}]]\n`, "/vault/dir/Home.md", FILES);
      await view.settle();

      expect(queries().map((q) => q.view)).toEqual([1]);

      view.blocks()[0]!.querySelector<HTMLElement>("header button")!.click();
      await view.settle();
      expect(queries().at(-1)!.view).toBe(0);
    },
  );

  it("keeps a view name that the sanitizer would drop as plain text", async () => {
    withFiles({ "/vault/bases/Books.base": "books" });
    const view = render("![[Books.base#To read --> Done]]\n", "/vault/dir/Home.md", FILES);
    await view.settle();

    expect(alert(view.el)).toBe("View not found: To read --> Done in bases/Books.base");
  });

  it("binds `this` of an embed in an embedded note to that note", async () => {
    withFiles({ "/vault/bases/Books.base": "books" });
    const fallback = invokeMock.getMockImplementation()!;
    invokeMock.mockImplementation(async (command, args) =>
      command === "read_text_file" && (args as { path: string }).path.endsWith(".md")
        ? "![[Books.base]]\n"
        : fallback(command, args),
    );
    const view = render("![[Embedded]]\n", "/vault/dir/Home.md", FILES);
    await view.settle();

    expect(queries().at(-1)).toMatchObject({ source: "books", thisFile: "sub/Embedded.md" });
  });

  it.each([
    ["Missing.base", ["dir/Home.md", "bases/Books.base"]],
    ["Books.base", ["dir/Home.md", "a/Books.base", "b/Books.base"]],
  ])("says that `![[%s]]` names no single file", async (target, files) => {
    withFiles({});
    const view = render(`![[${target}]]\n\ntext\n`, "/vault/dir/Home.md", files);
    await view.settle();

    expect(alert(view.blocks()[0]!)).toBe(`Base not found: ${target}`);
    expect(view.el.textContent).toContain("text");
    expect(queries()).toEqual([]);
  });

  it("says that a view is not in the file, and shows it once it is", async () => {
    withFiles({ "/vault/bases/Books.base": "books" });
    const view = render("![[Books.base#Later]]\n", "/vault/dir/Home.md", FILES);
    await view.settle();

    expect(alert(view.blocks()[0]!)).toBe("View not found: Later in bases/Books.base");
    expect(queries()).toEqual([]);

    const fallback = invokeMock.getMockImplementation()!;
    invokeMock.mockImplementation(async (command, args) =>
      command === "base_views"
        ? [...VIEWS, { name: "Later", type: "table" }]
        : fallback(command, args),
    );
    view.index.revision.set(1);
    await view.settle();

    expect(alert(view.el)).toBeUndefined();
    expect(queries().at(-1)!.view).toBe(2);
  });

  it("follows changes of the `.base` file", async () => {
    const contents = withFiles({ "/vault/bases/Books.base": "before" });
    const view = render("![[Books.base]]\n", "/vault/dir/Home.md", FILES);
    await view.settle();

    contents["/vault/bases/Books.base"] = "after";
    view.index.revision.set(1);
    await view.settle();

    expect(queries().at(-1)!.source).toBe("after");
  });

  it("follows a `.base` file that appears and goes", async () => {
    withFiles({ "/vault/bases/Books.base": "books" });
    const view = render("![[Books.base]]\n", "/vault/dir/Home.md", ["dir/Home.md"]);
    await view.settle();
    expect(alert(view.el)).toBe("Base not found: Books.base");

    view.vaultFiles.set(FILES);
    await view.settle();
    expect(view.el.querySelector("tbody")!.textContent).toContain("Dune");

    view.vaultFiles.set(["dir/Home.md"]);
    await view.settle();
    expect(alert(view.el)).toBe("Base not found: Books.base");
    expect(view.el.querySelector("table")).toBeNull();
    expect(view.el.querySelector("header button")).toBeNull();
  });

  it("shows the error of a file that cannot be read", async () => {
    withFiles({});
    const view = render("![[Books.base]]\n", "/vault/dir/Home.md", FILES);
    await view.settle();

    expect(alert(view.el)).toContain("No such file");
  });
});

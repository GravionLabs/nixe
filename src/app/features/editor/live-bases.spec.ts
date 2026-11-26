// @vitest-environment jsdom
// The bases of the live preview (#639) as the editor mounts them: the CodeMirror extension, the
// base component and the note edit service, with a fake backend.
import "@angular/compiler";
import { readFileSync } from "node:fs";
import { ApplicationRef, EnvironmentInjector, Injector, signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { BrowserTestingModule, platformBrowserTesting } from "@angular/platform-browser/testing";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  convertFileSrc: (path: string) => `asset://${path}`,
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";

import type { BaseResult, IndexStatus } from "../../core/file/backend";
import { IndexService } from "../../core/index/index.service";
import { SettingsService } from "../../core/settings/settings.service";
import { TabsService } from "../../core/tabs/tabs.service";
import { WorkspaceService } from "../../core/workspace/workspace.service";
import { BaseBlocks } from "../bases/base-blocks";
import { BaseCellComponent } from "../bases/base-cell.component";
import { BaseComponent } from "../bases/base.component";
import { mountLiveBase } from "./live-bases";
import { textChange } from "./text-change";
import { livePreview } from "./live-preview";

const invokeMock = vi.mocked(invoke);

const NOTE = "/vault/Home.md";
const BLOCK = "```base\nviews: []\n```";
const DOC = `---\nstatus: wish\n---\n\n${BLOCK}\n\n![[Books.base#Cards]]\n\nend`;

const result = (status: string): BaseResult => ({
  view: "All",
  columns: [
    { id: "file.name", label: "file.name" },
    { id: "status", label: "status", property: "status" },
  ],
  rows: [
    {
      path: "Home.md",
      cover: null,
      cells: [
        { type: "text", value: "Home" },
        { type: "text", value: status },
      ],
    },
  ],
  grouping: null,
  cards: null,
  unsupported: [],
});

let answer: () => Promise<BaseResult>;

beforeAll(() => {
  TestBed.initTestEnvironment(BrowserTestingModule, platformBrowserTesting());
});

beforeEach(() => {
  answer = async () => result("wish");
  invokeMock.mockReset();
  invokeMock.mockImplementation(async (command: string) => {
    if (command === "read_text_file") return "the base file";
    if (command === "base_views")
      return [
        { name: "All", type: "table" },
        { name: "Cards", type: "table" },
      ];
    if (command === "base_query") return answer();
    return undefined;
  });
});

let view: EditorView | undefined;
let bases: BaseBlocks | undefined;

afterEach(() => {
  view?.destroy();
  bases?.dispose();
  view = undefined;
  document.body.innerHTML = "";
});

function mount(doc = DOC) {
  const index = {
    status: signal({ state: "ready" } as IndexStatus),
    revision: signal(0),
  };
  const editText = vi.fn(async (change: (text: string) => string) => {
    const next = change(view!.state.doc.toString());
    // A minimal change, as `EditorComponent.applyText` makes it.
    view!.dispatch({ changes: textChange(view!.state.doc.toString(), next)! });
  });
  const handle = { holdsNote: () => true, dirty: () => false, editText };
  const tabs = {
    notice: signal<string | null>(null),
    openPreview: vi.fn().mockResolvedValue(undefined),
    tabsOf: vi.fn((path: string) =>
      path === NOTE ? [{ editor: { handle, unsaved: () => false } }] : [],
    ),
  };
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      { provide: IndexService, useValue: index },
      { provide: SettingsService, useValue: { previewTabs: signal(true) } },
      { provide: TabsService, useValue: tabs },
      {
        provide: WorkspaceService,
        useValue: { vaultRoot: signal("/vault"), vaultFiles: signal(["Books.base"]) },
      },
    ],
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
  const app = TestBed.inject(ApplicationRef);
  const mounted = new BaseBlocks(
    app,
    TestBed.inject(EnvironmentInjector),
    TestBed.inject(Injector),
  );
  bases = mounted;
  const parent = document.body.appendChild(document.createElement("div"));
  view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      selection: { anchor: doc.length },
      extensions: livePreview({
        render: () => undefined,
        mountBase: (el, origin, occurrence) =>
          mountLiveBase(mounted, el, origin, occurrence, NOTE, () => undefined),
      }),
    }),
  });
  const editor = view;
  const settle = async () => {
    for (let i = 0; i < 4; i++) {
      app.tick();
      await new Promise((resolve) => setTimeout(resolve));
    }
    app.tick();
  };
  const widgets = () => [...editor.dom.querySelectorAll<HTMLElement>(".cm-live-base")];
  const queries = () =>
    invokeMock.mock.calls
      .filter(([command]) => command === "base_query")
      .map(([, args]) => args as { source: string; view: number; sort: unknown; thisFile: string });
  const moveTo = (needle: string) =>
    editor.dispatch({ selection: { anchor: editor.state.doc.toString().indexOf(needle) } });
  const moveOut = () => editor.dispatch({ selection: { anchor: editor.state.doc.length } });
  return { view: editor, index, tabs, editText, settle, widgets, queries, moveTo, moveOut };
}

describe("bases in the live preview", () => {
  it("draws a base block and a .base embed, with the note as `this`", async () => {
    const live = mount();
    await live.settle();

    expect(live.widgets().length).toBe(2);
    expect(live.view.dom.textContent).not.toContain("![[Books.base#Cards]]");
    expect(live.queries()).toEqual([
      { source: "views: []\n", view: 0, sort: null, thisFile: "Home.md" },
      { source: "the base file", view: 1, sort: null, thisFile: "Home.md" },
    ]);
    expect(live.widgets()[0]!.querySelector("tbody")?.textContent).toContain("Home");
  });

  it("shows the source with the cursor inside and does not query again afterwards", async () => {
    const live = mount();
    await live.settle();

    live.moveTo("views:");
    expect(live.widgets().length).toBe(1);
    expect(live.view.dom.textContent).toContain("views: []");
    live.moveOut();
    await live.settle();

    expect(live.widgets().length).toBe(2);
    expect(live.widgets()[0]!.querySelector("tbody")?.textContent).toContain("wish");
    expect(live.queries().length).toBe(2);
  });

  it("queries again when the vault or the source changed while the source was shown", async () => {
    const live = mount(`${BLOCK}\n\nend`);
    await live.settle();
    live.moveTo("views:");
    live.index.revision.set(1);
    live.moveOut();
    await live.settle();
    expect(live.queries().length).toBe(2);

    live.moveTo("views:");
    const at = live.view.state.doc.toString().indexOf("[]");
    live.view.dispatch({ changes: { from: at, to: at + 2, insert: "[1]" } });
    live.moveOut();
    await live.settle();
    expect(live.queries().at(-1)?.source).toBe("views: [1]\n");
  });

  it("destroys the base with its widget and ignores its late answer", async () => {
    const answers: ((value: BaseResult) => void)[] = [];
    answer = () => new Promise((resolve) => answers.push(resolve));
    const live = mount(`${BLOCK}\n\nend`);
    await live.settle();
    const old = live.widgets()[0]!;

    live.moveTo("views:");
    answers[0]!(result("late"));
    await live.settle();
    expect(old.textContent).not.toContain("late");

    // The answer was not kept: the new widget asks again.
    live.moveOut();
    await live.settle();
    expect(answers.length).toBe(2);
    answers[1]!(result("fresh"));
    await live.settle();
    expect(live.widgets()[0]!.textContent).toContain("fresh");
  });

  it("switches the view and sorts in the widget, and keeps both while it is not drawn", async () => {
    const live = mount(`${BLOCK}\n\nend`);
    await live.settle();
    const widget = live.widgets()[0]!;
    const second = [...widget.querySelectorAll<HTMLElement>(".views button")][1]!;
    second.click();
    await live.settle();
    expect(live.queries().at(-1)?.view).toBe(1);

    widget.querySelector<HTMLButtonElement>("thead th button")!.click();
    await live.settle();
    expect(live.queries().at(-1)?.sort).toEqual({ property: "file.name", direction: "ASC" });
    const count = live.queries().length;

    live.moveTo("views:");
    live.moveOut();
    await live.settle();
    expect(live.queries().length).toBe(count);
    expect(live.widgets()[0]!.querySelector("th[aria-sort='ascending']")).not.toBeNull();
  });

  it("opens the note of a row", async () => {
    const live = mount(`${BLOCK}\n\nend`);
    await live.settle();

    live.widgets()[0]!.querySelector<HTMLButtonElement>("button.note-link")!.click();
    expect(live.tabs.openPreview).toHaveBeenCalledWith(NOTE);
  });

  it("writes an edited property of the open note into the editor buffer", async () => {
    const live = mount();
    await live.settle();
    const widget = live.widgets()[0]!;
    widget.querySelector<HTMLButtonElement>("app-base-cell button.value")!.click();
    await live.settle();
    const input = widget.querySelector<HTMLInputElement>("app-base-cell input")!;
    input.value = "reading";
    input.dispatchEvent(new Event("blur"));
    await live.settle();

    expect(live.editText).toHaveBeenCalledOnce();
    expect(live.view.state.doc.toString()).toContain("status: reading");
    expect(live.widgets()[0]!.textContent).toContain("reading");
    expect(invokeMock.mock.calls.map(([command]) => command)).not.toContain("replace_text_file");
  });
});

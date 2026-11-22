// @vitest-environment jsdom
import "@angular/compiler";
import { signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { BrowserTestingModule, platformBrowserTesting } from "@angular/platform-browser/testing";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { EditorService } from "../editor/editor.service";
import { backend } from "../file/backend";
import { DocumentService } from "../file/document.service";
import { SearchService } from "../index/search.service";
import { OutlineService } from "../outline/outline.service";
import { ShellService } from "../shell/shell.service";
import { SwitcherService } from "../switcher/switcher.service";
import { TabsService } from "../tabs/tabs.service";
import { TemplateService } from "../templates/template.service";
import { RecentPickerService } from "../workspace/recent-picker.service";
import { VaultOpsService } from "../workspace/vault-ops.service";
import { WorkspaceService } from "../workspace/workspace.service";
import { CommandRegistry } from "./command-registry";
import { PaletteService, parseQuery } from "./palette.service";

const tick = () => new Promise((r) => setTimeout(r));

describe("parseQuery", () => {
  it("picks the mode by the first character", () => {
    expect(parseQuery("foo")).toEqual({ mode: "notes", text: "foo" });
    expect(parseQuery(">run")).toEqual({ mode: "commands", text: "run" });
    expect(parseQuery("@ intro")).toEqual({ mode: "headings", text: "intro" });
    expect(parseQuery("#todo")).toEqual({ mode: "tags", text: "todo" });
    expect(parseQuery("/daily")).toEqual({ mode: "templates", text: "daily" });
    expect(parseQuery("~")).toEqual({ mode: "vaults", text: "" });
    expect(parseQuery("")).toEqual({ mode: "notes", text: "" });
  });
});

describe("PaletteService", () => {
  let registry: CommandRegistry;
  let palette: PaletteService;
  const docOpen = vi.fn();
  const newTab = vi.fn();
  const scrollToLine = vi.fn();
  const insert = vi.fn();
  const choose = vi.fn();
  const pendingLine = signal<number | null>(null);
  const searchQuery = vi.fn();
  const show = vi.fn();
  const headings = signal([
    { level: 1, text: "Intro", line: 1 },
    { level: 2, text: "Details", line: 5 },
  ]);
  const search = vi.fn();
  const templateList = vi.fn();
  const vaults = signal(["/a", "/b"]);

  beforeAll(() => {
    TestBed.initTestEnvironment(BrowserTestingModule, platformBrowserTesting());
  });

  beforeEach(() => {
    vi.clearAllMocks();
    pendingLine.set(null);
    search.mockImplementation((q: string) => ({
      matches: q
        ? []
        : [
            {
              entry: { path: "Alpha.md", title: "Alpha", aliases: [] },
              label: "Alpha",
              isAlias: false,
              score: 0,
              positions: [],
            },
          ],
      truncated: false,
    }));
    templateList.mockResolvedValue([
      { path: "T/Daily.md", name: "Daily" },
      { path: "T/Meeting.md", name: "Meeting" },
    ]);
    vi.spyOn(backend, "tags").mockResolvedValue([
      { tag: "todo", count: 3 },
      { tag: "idea", count: 1 },
    ]);
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        { provide: SwitcherService, useValue: { search, load: vi.fn() } },
        { provide: OutlineService, useValue: { headings } },
        { provide: TemplateService, useValue: { list: templateList, insert } },
        { provide: RecentPickerService, useValue: { vaults, prune: vi.fn(), choose } },
        { provide: WorkspaceService, useValue: { vaultRoot: signal("/v") } },
        { provide: DocumentService, useValue: { open: docOpen, pendingLine } },
        { provide: EditorService, useValue: { editing: () => true, handle: { scrollToLine } } },
        { provide: TabsService, useValue: { openInNewTab: newTab, openPreview: docOpen } },
        { provide: VaultOpsService, useValue: { createNoteForLink: vi.fn() } },
        { provide: SearchService, useValue: { setQuery: searchQuery } },
        { provide: ShellService, useValue: { show } },
      ],
    });
    registry = TestBed.inject(CommandRegistry);
    palette = TestBed.inject(PaletteService);
    registry.register({
      id: "toggle-sidebar",
      group: "View",
      title: "Toggle sidebar",
      run: () => {},
    });
    registry.register({ id: "zoom-in", group: "View", title: "Zoom in", run: () => {} });
    registry.register({
      id: "hidden",
      group: "View",
      title: "Zoom hidden",
      when: () => false,
      run: () => {},
    });
  });

  const kinds = () => palette.items().map((i) => i.kind);

  it("finds notes without a prefix", () => {
    palette.open();
    expect(palette.mode()).toBe("notes");
    expect(kinds()).toEqual(["note"]);
  });

  it("lists commands alphabetically after >, skipping unavailable ones", () => {
    palette.open(">");
    expect(palette.mode()).toBe("commands");
    expect(palette.items().map((i) => (i.kind === "command" ? i.command.id : ""))).toEqual([
      "toggle-sidebar",
      "zoom-in",
    ]);
    palette.setQuery(">tsb");
    expect(palette.items().map((i) => (i.kind === "command" ? i.command.id : ""))).toEqual([
      "toggle-sidebar",
    ]);
  });

  it("lists the commands in groups in a fixed order with one heading per group", () => {
    registry.register({ id: "sync", group: "Git", title: "Sync", run: () => {} });
    registry.register({ id: "back", group: "Navigate", title: "Back", run: () => {} });
    registry.register({ id: "open", group: "File", title: "Open", run: () => {} });
    palette.open(">");
    const rows = palette
      .items()
      .map((i) => (i.kind === "command" ? [i.command.id, i.heading, i.label] : []));
    expect(rows).toEqual([
      ["open", "File", undefined],
      ["toggle-sidebar", "View", undefined],
      ["zoom-in", undefined, undefined],
      ["back", "Navigate", undefined],
      ["sync", "Git", undefined],
    ]);
  });

  it("ranks a query by match and labels the group instead of headings", () => {
    registry.register({ id: "zoom-out", group: "Edit", title: "Zoom out", run: () => {} });
    palette.setQuery(">zoom");
    const rows = palette
      .items()
      .map((i) => (i.kind === "command" ? [i.command.id, i.heading, i.label] : []));
    expect(rows).toEqual([
      ["zoom-in", undefined, "View"],
      ["zoom-out", undefined, "Edit"],
    ]);
  });

  it("puts recently run commands first when the query is empty", async () => {
    palette.open(">");
    await palette.run(palette.items()[1]);
    palette.open(">");
    expect(palette.items().map((i) => (i.kind === "command" ? i.command.id : ""))).toEqual([
      "zoom-in",
      "toggle-sidebar",
    ]);
  });

  it("runs the chosen command and closes", async () => {
    const run = vi.fn();
    registry.register({ id: "x", group: "Other", title: "Xylophone", run });
    palette.open(">xylo");
    await palette.run(palette.current()!);
    expect(run).toHaveBeenCalledOnce();
    expect(palette.visible()).toBe(false);
  });

  it("lists the headings of the open note after @ and scrolls to the chosen one", async () => {
    palette.open("@");
    expect(palette.items().map((i) => (i.kind === "heading" ? i.heading.text : ""))).toEqual([
      "Intro",
      "Details",
    ]);
    palette.setQuery("@det");
    await palette.run(palette.current()!);
    expect(scrollToLine).toHaveBeenCalledWith(5);
    expect(palette.visible()).toBe(false);
  });

  it("lists tags after # and searches the chosen one", async () => {
    palette.open("#");
    await tick();
    expect(palette.items().map((i) => (i.kind === "tag" ? i.tag.tag : ""))).toEqual([
      "todo",
      "idea",
    ]);
    palette.setQuery("#ide");
    await palette.run(palette.current()!);
    expect(show).toHaveBeenCalledWith("search");
    expect(searchQuery).toHaveBeenCalledWith("tag:#idea");
  });

  it("lists templates after / with the recently inserted first", async () => {
    palette.open("/");
    await tick();
    expect(palette.items().map((i) => (i.kind === "template" ? i.entry.name : ""))).toEqual([
      "Daily",
      "Meeting",
    ]);
    await palette.run(palette.items()[1]);
    expect(insert).toHaveBeenCalledWith({ path: "T/Meeting.md", name: "Meeting" });
    palette.open("/");
    expect(palette.items().map((i) => (i.kind === "template" ? i.entry.name : ""))).toEqual([
      "Meeting",
      "Daily",
    ]);
  });

  it("shows why there are no templates", async () => {
    templateList.mockRejectedValue(new Error("No template folder."));
    palette.open("/");
    await tick();
    expect(palette.items()).toEqual([]);
    expect(palette.notice()).toBe("No template folder.");
    palette.setQuery("");
    expect(palette.notice()).toBeNull();
  });

  it("openTemplates fails with the reason instead of opening", async () => {
    templateList.mockRejectedValue(new Error("No templates in T."));
    await expect(palette.openTemplates()).rejects.toThrow("No templates in T.");
    expect(palette.visible()).toBe(false);
    templateList.mockResolvedValue([{ path: "T/A.md", name: "A" }]);
    await palette.openTemplates();
    expect(palette.visible()).toBe(true);
    expect(palette.mode()).toBe("templates");
  });

  it("opens the recent vaults after ~", async () => {
    palette.open("~");
    expect(kinds()).toEqual(["vault", "vault"]);
    await palette.run(palette.items()[1]);
    expect(choose).toHaveBeenCalledWith("/b");
  });

  it("switches the mode when the prefix is deleted, without closing", () => {
    palette.open(">zoom");
    expect(palette.mode()).toBe("commands");
    palette.setQuery("zoom");
    expect(palette.mode()).toBe("notes");
    expect(palette.visible()).toBe(true);
    palette.setQuery("@");
    expect(palette.mode()).toBe("headings");
    expect(palette.visible()).toBe(true);
  });

  it("opens a note, in a new tab on request", async () => {
    palette.open();
    await palette.run(palette.current()!);
    expect(docOpen).toHaveBeenCalledWith("/v/Alpha.md");
    palette.open();
    await palette.run(palette.current()!, true);
    expect(newTab).toHaveBeenCalledWith("/v/Alpha.md");
  });

  it("wraps the selection and has no current item when nothing matches", () => {
    palette.open(">");
    palette.move(-1);
    expect(palette.selected()).toBe(1);
    palette.move(1);
    expect(palette.selected()).toBe(0);
    palette.setQuery(">zzzz");
    expect(palette.current()).toBeNull();
  });
});

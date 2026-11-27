// @vitest-environment jsdom
import "@angular/compiler";
import { signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { By } from "@angular/platform-browser";
import { HxSelect } from "@gravionlabs/helix-ui";
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
import type { BaseResult, IndexStatus } from "../../core/file/backend";
import { IndexService } from "../../core/index/index.service";
import { SettingsService } from "../../core/settings/settings.service";
import { TabsService } from "../../core/tabs/tabs.service";
import { FolderRolesService } from "../../core/workspace/folder-roles.service";
import { WorkspaceService } from "../../core/workspace/workspace.service";
import { LinksViewService } from "./links-view.service";
import { LinksComponent } from "./links.component";

const invokeMock = vi.mocked(invoke);

const note = (title: string, status: string, url = `https://example.com/${title}`) =>
  `---\ntype: link\nurl: ${url}\ntitle: ${title}\nstatus: ${status}\n---\n\n## Notes\n`;

const COLUMNS = ["file.name", "title", "site", "tags", "saved", "status", "url"];

describe("LinksComponent", () => {
  let files: Map<string, string>;
  const revision = signal(0);
  const state = signal<IndexStatus>({ state: "ready" } as IndexStatus);
  const tabs = {
    notice: signal<string | null>(null),
    openPreview: vi.fn().mockResolvedValue(undefined),
    openInNewTab: vi.fn().mockResolvedValue(undefined),
    tabsOf: vi.fn().mockReturnValue([]),
  };

  /** What the core answers for the files of the fake vault. */
  const answer = (): BaseResult => ({
    view: "Links",
    columns: COLUMNS.map((id) => ({ id, label: id })),
    rows: [...files].map(([path, content]) => {
      const value = (key: string) => new RegExp(`^${key}: (.*)$`, "m").exec(content)?.[1] ?? null;
      return {
        path: path.slice("/vault/".length),
        cover: null,
        cells: COLUMNS.map((id) => ({ type: "text", value: value(id) })),
      };
    }),
    grouping: null,
    unsupported: [],
  });

  beforeAll(() => TestBed.initTestEnvironment(BrowserTestingModule, platformBrowserTesting()));

  beforeEach(() => {
    vi.clearAllMocks();
    tabs.notice.set(null);
    state.set({ state: "ready" } as IndexStatus);
    files = new Map([
      ["/vault/Links/One.md", note("One", "unread")],
      ["/vault/Links/Recipes/Two.md", note("Two", "read")],
    ]);
    invokeMock.mockImplementation(async (command: string, args?: unknown) => {
      const a = args as Record<string, string>;
      if (command === "base_query") return answer();
      if (command === "read_text_file") return files.get(a["path"]!);
      if (command === "replace_text_file") files.set(a["path"]!, a["content"]!);
      return undefined;
    });
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        { provide: IndexService, useValue: { status: state, revision } },
        { provide: SettingsService, useValue: { previewTabs: signal(false) } },
        { provide: TabsService, useValue: tabs },
        { provide: FolderRolesService, useValue: { roles: signal([]) } },
        { provide: WorkspaceService, useValue: { vaultRoot: signal("/vault") } },
      ],
    });
    TestBed.overrideComponent(LinksComponent, { set: { styleUrl: undefined } });
  });

  async function shown() {
    const fixture = TestBed.createComponent(LinksComponent);
    const el = fixture.nativeElement as HTMLElement;
    const settle = async () => {
      for (let i = 0; i < 3; i++) {
        fixture.detectChanges();
        await new Promise((resolve) => setTimeout(resolve));
      }
      fixture.detectChanges();
    };
    await settle();
    const titles = () =>
      [...el.querySelectorAll(".card-title, td .note-link")].map((e) => e.textContent!.trim());
    const button = (label: string) =>
      el.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
    // The first select of the header is the collection filter.
    const choose = (value: string) =>
      fixture.debugElement.query(By.directive(HxSelect)).componentInstance.value.set(value);
    return { el, choose, settle, titles, button, view: TestBed.inject(LinksViewService) };
  }

  it("starts with the unread inbox and shows every link in All", async () => {
    const { titles, view, settle } = await shown();
    expect(view.tab()).toBe("unread");
    expect(titles()).toEqual(["One"]);
    view.tab.set("all");
    await settle();
    expect(titles()).toEqual(["One", "Two"]);
    view.status.set("read");
    await settle();
    expect(titles()).toEqual(["Two"]);
  });

  it("filters by the chosen collection, and ignores one no link has", async () => {
    const { choose, titles, view, settle } = await shown();
    view.tab.set("all");
    await settle();
    choose("Recipes");
    await settle();
    expect(titles()).toEqual(["Two"]);
    view.collection.set("Gone");
    await settle();
    expect(titles()).toEqual(["One", "Two"]);
  });

  it("shows the table with a status column", async () => {
    const { el, titles, view, settle } = await shown();
    view.layout.set("table");
    await settle();
    expect([...el.querySelectorAll("th")].map((th) => th.textContent!.trim())).toEqual([
      "Title",
      "Site",
      "Tags",
      "Saved",
      "Status",
    ]);
    expect(titles()).toEqual(["One"]);
  });

  it("writes the status into the frontmatter and back", async () => {
    const { titles, button, view, settle, el } = await shown();
    button("Mark One read").click();
    await settle();
    expect(files.get("/vault/Links/One.md")).toBe(note("One", "read"));
    expect(titles()).toEqual([]);
    expect(el.textContent).toContain("No unread links.");

    view.tab.set("all");
    await settle();
    button("Mark One unread").click();
    await settle();
    expect(files.get("/vault/Links/One.md")).toBe(note("One", "unread"));
    expect(button("Mark One read")).not.toBeNull();
  });

  it("keeps the old status and says why when the note cannot be written", async () => {
    const { titles, button, settle } = await shown();
    const answers = invokeMock.getMockImplementation()!;
    invokeMock.mockImplementation(async (command: string, args?: unknown) => {
      if (command === "replace_text_file") throw new Error("read-only");
      return answers(command, args as never);
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    button("Mark One read").click();
    await settle();
    expect(titles()).toEqual(["One"]);
    expect(tabs.notice()).toBe("One was not marked read: read-only");
  });

  it("opens the note on a click and the page with Ctrl or Cmd", async () => {
    const { el, settle } = await shown();
    const title = el.querySelector<HTMLButtonElement>(".card-title")!;
    title.click();
    await settle();
    expect(tabs.openInNewTab).toHaveBeenCalledWith("/vault/Links/One.md");
    expect(openUrl).not.toHaveBeenCalled();

    for (const key of ["ctrlKey", "metaKey"]) {
      title.dispatchEvent(new MouseEvent("click", { bubbles: true, [key]: true }));
      await settle();
    }
    expect(vi.mocked(openUrl).mock.calls).toEqual([
      ["https://example.com/One"],
      ["https://example.com/One"],
    ]);
    expect(tabs.openInNewTab).toHaveBeenCalledTimes(1);
  });

  it("does not open an address that is not of the web", async () => {
    files = new Map([["/vault/Links/Bad.md", note("Bad", "unread", "file:///etc/passwd")]]);
    const { el, settle } = await shown();
    el.querySelector(".card-title")!.dispatchEvent(new MouseEvent("click", { ctrlKey: true }));
    await settle();
    expect(openUrl).not.toHaveBeenCalled();
    expect(tabs.notice()).toBe("Bad has no web address.");
  });

  it("says when there are no links and when the index failed", async () => {
    files = new Map();
    const { el, settle } = await shown();
    expect(el.textContent).toContain("No links yet.");
    state.set({ state: "error" } as IndexStatus);
    await settle();
    expect(el.querySelector('[role="alert"]')!.textContent).toContain(
      "The vault index is not available.",
    );
  });
});

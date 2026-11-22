// @vitest-environment jsdom
import "@angular/compiler";
import { signal } from "@angular/core";
import { By } from "@angular/platform-browser";
import { HX_UPDATE_BACKEND, provideHxAppInfo } from "@gravionlabs/helix-desktop/tauri";
import type { HxUpdateBackend } from "@gravionlabs/helix-desktop/tauri";
import { HxTooltip } from "@gravionlabs/helix-ui";
import { TestBed } from "@angular/core/testing";
import { BrowserTestingModule, platformBrowserTesting } from "@angular/platform-browser/testing";
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

import { CommandRegistry } from "../../core/commands/command-registry";
import { DocumentService } from "../../core/file/document.service";
import { EditorService } from "../../core/editor/editor.service";
import { countText } from "../../core/editor/text-stats";
import type { GitStatus } from "../../core/file/backend";
import { BacklinksService } from "../../core/index/backlinks.service";
import { ChangesService } from "../../core/git/changes.service";
import { GitService } from "../../core/git/git.service";
import { ReviewService } from "../../core/git/review.service";
import { ShortcutService } from "../../core/commands/shortcut.service";
import { SettingsService } from "../../core/settings/settings.service";
import { ShellService } from "../../core/shell/shell.service";
import { StatusBarComponent } from "./status-bar.component";

interface Options {
  status?: GitStatus | null;
  syncState?: { phase: string; message: string };
  version?: string;
  update?: { version: string; notes?: string } | null;
  zoom?: number;
  pulled?: number;
  waiting?: number;
  stats?: ReturnType<typeof countText> | null;
  backlinks?: number;
  linksState?: string;
  mode?: "live" | "source" | "reading";
  path?: string | null;
}

function render(o: Options = {}) {
  const sync = vi.fn();
  const show = vi.fn();
  const showSync = vi.fn();
  const backend = {
    check: vi.fn(async () => (o.update ? { notes: null, date: null, ...o.update } : null)),
    install: vi.fn(async () => {}),
    relaunch: vi.fn(async () => {}),
  } satisfies HxUpdateBackend;
  const execute = vi.fn();
  const zoom = signal(o.zoom ?? 100);
  const showPanelTab = vi.fn();
  const backlinks = signal(
    Array.from({ length: o.backlinks ?? 0 }, (_, i) => ({ path: `b${i}.md` })),
  );
  const key = signal("a|ready|1");
  const refresh = vi.fn();
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      {
        provide: GitService,
        useValue: {
          status: signal(o.status ?? null),
          sync,
          syncState: signal(o.syncState ?? { phase: "idle", message: "" }),
        },
      },
      {
        provide: ChangesService,
        useValue: {
          pulled: signal(
            Array.from({ length: o.pulled ?? 0 }, (_, i) => ({
              path: `n${i}.md`,
              kind: "modified",
            })),
          ),
          showSync,
        },
      },
      { provide: ReviewService, useValue: { count: signal(o.waiting ?? 0) } },
      { provide: ShellService, useValue: { show } },
      { provide: SettingsService, useValue: { zoom, showPanelTab } },
      {
        provide: ShortcutService,
        useValue: {
          keys: (id: string) => KEYS[id] ?? [],
          display: (id: string) => (KEYS[id] ?? []).join("+"),
        },
      },
      {
        provide: EditorService,
        useValue: { stats: signal(o.stats ?? null), mode: signal(o.mode ?? "live") },
      },
      {
        provide: DocumentService,
        useValue: { path: signal(o.path === undefined ? "/n.md" : o.path) },
      },
      {
        provide: BacklinksService,
        useValue: { state: signal(o.linksState ?? "idle"), backlinks, key, refresh },
      },
      { provide: CommandRegistry, useValue: { execute } },
      provideHxAppInfo({ version: o.version ?? "1.2.0" }),
      { provide: HX_UPDATE_BACKEND, useValue: backend },
    ],
  });
  const fixture = TestBed.createComponent(StatusBarComponent);
  fixture.detectChanges();
  const el = fixture.nativeElement as HTMLElement;
  return {
    el,
    showPanelTab,
    backlinks,
    key,
    refresh,
    show,
    showSync,
    sync,
    backend,
    execute,
    zoom,
    fixture,
    text: () => el.textContent ?? "",
  };
}

const repo: GitStatus = {
  branch: "main",
  changes: [{ path: "a.md", kind: "added" }],
  ahead: 2,
  behind: 3,
  hasRemote: true,
};

const KEYS: Record<string, string[]> = {
  "new-note": ["Ctrl", "N"],
  "new-folder": ["Ctrl", "Shift", "N"],
  "toggle-editor": ["Ctrl", "E"],
};

describe("StatusBarComponent", () => {
  beforeAll(() => {
    TestBed.initTestEnvironment(BrowserTestingModule, platformBrowserTesting());
  });

  it("shows branch, changed files and ahead/behind", () => {
    const { text } = render({ status: repo });
    expect(text()).toContain("main");
    expect(text()).toContain("1 changed");
    expect(text()).toContain("↑2 ↓3");
  });

  it("is shown without a repository, with no Git items", () => {
    const { el, text } = render({ status: null });
    expect(el.querySelector("hx-status-bar")).not.toBeNull();
    expect(el.querySelector(".git")).toBeNull();
    expect(el.querySelector(".sync-button")).toBeNull();
    expect(text()).toContain("1.2.0");
    expect(el.querySelector("hx-status-zoom")).not.toBeNull();
  });

  it("shows words and characters with the reading time as tooltip while editing", () => {
    const none = render();
    expect(none.el.querySelector(".words")).toBeNull();
    const r = render({ stats: countText("one two three") });
    const item = r.el.querySelector(".words")!;
    expect(item.textContent).toContain("3 words, 11 characters");
    expect(r.fixture.debugElement.query(By.css(".words")).injector.get(HxTooltip).text()).toBe(
      "Reading time: under a minute",
    );
    const sel = render({ stats: countText("one", true) });
    expect(sel.el.querySelector(".words")!.textContent).toContain("1 word, 3 characters selected");
  });

  it("names the reading view as read only, and no other mode", () => {
    expect(render({ mode: "reading" }).el.querySelector(".read-only")?.textContent).toContain(
      "Read only",
    );
    expect(render({ mode: "live" }).el.querySelector(".read-only")).toBeNull();
    expect(render({ mode: "source" }).el.querySelector(".read-only")).toBeNull();
    expect(render({ mode: "reading", path: null }).el.querySelector(".read-only")).toBeNull();
  });

  describe("backlinks", () => {
    it("shows the count of the open note, singular and plural", () => {
      expect(
        render({ linksState: "ready", backlinks: 0 }).el.querySelector(".backlinks")!.textContent,
      ).toContain("0 backlinks");
      expect(
        render({ linksState: "ready", backlinks: 1 }).el.querySelector(".backlinks")!.textContent,
      ).toContain("1 backlink");
      expect(
        render({ linksState: "ready", backlinks: 4 }).el.querySelector(".backlinks")!.textContent,
      ).toContain("4 backlinks");
    });

    it("is hidden without a vault or an open note, or while the index is not ready", () => {
      expect(render({ linksState: "idle" }).el.querySelector(".backlinks")).toBeNull();
      expect(render({ linksState: "loading" }).el.querySelector(".backlinks")).toBeNull();
    });

    it("opens the links panel on click", () => {
      const r = render({ linksState: "ready", backlinks: 2 });
      r.el.querySelector<HTMLElement>(".backlinks button")!.click();
      expect(r.showPanelTab).toHaveBeenCalledWith("links");
    });

    it("reads the lists again when the index changes", () => {
      const r = render({ linksState: "ready" });
      expect(r.refresh).toHaveBeenCalledTimes(1);
      r.key.set("a|ready|2");
      r.fixture.detectChanges();
      expect(r.refresh).toHaveBeenCalledTimes(2);
    });
  });

  it("shows the Git view in the sidebar", () => {
    const r = render({
      status: { branch: null, changes: [], ahead: 0, behind: 0, hasRemote: true },
    });
    r.el.querySelector<HTMLElement>(".git button")!.click();
    expect(r.show).toHaveBeenCalledWith("git");
    expect(r.text()).toContain("detached HEAD");
  });

  it("offers the notes the last pull changed and opens their list", () => {
    const none = render({ status: repo });
    expect(none.el.querySelector(".pulled")).toBeNull();
    const one = render({ status: repo, pulled: 1 });
    expect(one.el.querySelector(".pulled")!.textContent).toContain("1 note changed");
    const r = render({ status: repo, pulled: 3 });
    expect(r.el.querySelector(".pulled")!.textContent).toContain("3 notes changed");
    r.el.querySelector<HTMLElement>(".pulled button")!.click();
    expect(r.showSync).toHaveBeenCalled();
    expect(r.show).toHaveBeenCalledWith("git");
  });

  it("shows the number of suggestions waiting for review and opens the Git view", () => {
    expect(render({ status: repo }).el.querySelector(".review")).toBeNull();
    const one = render({ status: repo, waiting: 1 });
    expect(one.el.querySelector(".review")!.textContent).toContain("1 suggestion to review");
    const r = render({ status: repo, waiting: 3 });
    expect(r.el.querySelector(".review")!.textContent).toContain("3 suggestions to review");
    r.el.querySelector<HTMLElement>(".review button")!.click();
    expect(r.show).toHaveBeenCalledWith("git");
  });

  it("syncs from the button and shows the result", () => {
    const r = render({ status: repo, syncState: { phase: "done", message: "Already in sync" } });
    r.el.querySelector<HTMLElement>(".sync-button button")!.click();
    expect(r.sync).toHaveBeenCalled();
    expect(r.el.querySelector(".result")!.textContent).toContain("Already in sync");
  });

  it("disables the sync button while syncing", () => {
    const r = render({ status: repo, syncState: { phase: "syncing", message: "" } });
    expect(r.el.querySelector<HTMLButtonElement>(".sync-button button")!.disabled).toBe(true);
  });

  it("marks a failed sync as an error", () => {
    const r = render({ status: repo, syncState: { phase: "error", message: "boom" } });
    expect(r.el.querySelector(".result")!.textContent).toContain("boom");
  });

  it("is not rendered on iOS", () => {
    document.documentElement.dataset["platform"] = "ios";
    try {
      const r = render({ status: repo });
      expect(r.el.querySelector("hx-status-bar")).toBeNull();
      expect(r.text().trim()).toBe("");
    } finally {
      delete document.documentElement.dataset["platform"];
    }
  });

  describe("zoom", () => {
    const zoomButtons = (el: HTMLElement) =>
      Array.from(el.querySelectorAll<HTMLButtonElement>("hx-status-zoom button"));

    it("shows the level", () => {
      expect(render({ zoom: 120 }).text()).toContain("120%");
    });

    it("zooms in and out in steps of 10", () => {
      const r = render({ zoom: 100 });
      const [out, , zoomIn] = zoomButtons(r.el);
      zoomIn.click();
      expect(r.zoom()).toBe(110);
      out.click();
      out.click();
      expect(r.zoom()).toBe(90);
    });

    it("resets to 100 from the level", () => {
      const r = render({ zoom: 150 });
      zoomButtons(r.el)[1].click();
      expect(r.zoom()).toBe(100);
    });

    it("stops at the limits", () => {
      const max = render({ zoom: 300 });
      zoomButtons(max.el)[2].click();
      expect(max.zoom()).toBe(300);
      const min = render({ zoom: 50 });
      zoomButtons(min.el)[0].click();
      expect(min.zoom()).toBe(50);
    });
  });

  describe("version and shortcuts", () => {
    it("shows the version without a badge on a stable build", () => {
      const r = render({ version: "1.2.0" });
      expect(r.text()).toContain("1.2.0");
      expect(r.text()).not.toContain("RC");
    });

    it("shows the RC badge on an RC build, which keeps the manual check", () => {
      const r = render({ version: "1.3.0-rc011" });
      expect(r.text()).toContain("RC");
      expect(r.text()).toContain("Check for updates");
      expect(r.backend.check).not.toHaveBeenCalled();
    });

    it("tooltips the git sync item", () => {
      const r = render({ status: repo });
      const tip = r.fixture.debugElement.query(By.css(".sync-button")).injector.get(HxTooltip);
      expect(tip.text()).toBe("Commit, pull with rebase and push");
    });

    it("opens the commands from the ? item", () => {
      const r = render();
      r.el.querySelector<HTMLElement>(".shortcuts button")!.click();
      expect(r.execute).toHaveBeenCalledWith("command-palette");
    });
  });

  describe("update state", () => {
    const flush = async (r: ReturnType<typeof render>) => {
      await r.fixture.whenStable();
      r.fixture.detectChanges();
    };

    it("idle: offers the check, and a click with no update shows Up to date", async () => {
      const r = render();
      expect(r.text()).toContain("Check for updates");
      r.el.querySelector<HTMLElement>("hx-status-update button")!.click();
      await flush(r);
      expect(r.backend.check).toHaveBeenCalled();
      expect(r.text()).toContain("Up to date");
    });

    it("a found update shows its version", async () => {
      const r = render({ update: { version: "1.3.0", notes: "Fixes" } });
      r.el.querySelector<HTMLElement>("hx-status-update button")!.click();
      await flush(r);
      expect(r.text()).toContain("1.3.0");
    });
  });
});

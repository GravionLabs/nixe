// @vitest-environment jsdom
import "@angular/compiler";
import { signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { BrowserTestingModule, platformBrowserTesting } from "@angular/platform-browser/testing";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

import { backend } from "../file/backend";
import { DocumentService } from "../file/document.service";
import { SettingsService } from "../settings/settings.service";
import { TabsService } from "../tabs/tabs.service";
import { RecentPickerService, missingMessage } from "./recent-picker.service";
import { WorkspaceService } from "./workspace.service";

describe("recent vaults in WorkspaceService", () => {
  const path = signal<string | null>(null);
  const doc = { path, open: vi.fn() };
  let workspace: WorkspaceService;
  let settings: SettingsService;
  let dirs: Set<string>;
  let files: Set<string>;

  const flush = async () => {
    TestBed.tick();
    await Promise.resolve();
  };

  beforeAll(() => {
    TestBed.initTestEnvironment(BrowserTestingModule, platformBrowserTesting());
  });

  beforeEach(() => {
    localStorage.clear();
    window.matchMedia = vi.fn().mockReturnValue({ matches: false, addEventListener: vi.fn() });
    dirs = new Set(["/a", "/b", "/c", "/d", "/e", "/f"]);
    files = new Set();
    path.set(null);
    doc.open = vi.fn().mockImplementation(async (p: string) => path.set(p));
    vi.spyOn(backend, "isFile").mockImplementation(async (p) => files.has(p));
    vi.spyOn(backend, "isDir").mockImplementation(async (p) => dirs.has(p));
    vi.spyOn(backend, "listDir").mockImplementation(
      async (d) =>
        [
          { name: "home.md", path: `${d}/home.md`, isDir: false },
          { name: "other.md", path: `${d}/other.md`, isDir: false },
        ] as never,
    );
    vi.spyOn(backend, "findVaultRoot").mockImplementation(async (p) => p);
    vi.spyOn(backend, "listVaultFiles").mockResolvedValue([]);
    vi.spyOn(backend, "indexStart").mockResolvedValue(undefined as never);
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ providers: [{ provide: DocumentService, useValue: doc }] });
    settings = TestBed.inject(SettingsService);
    workspace = TestBed.inject(WorkspaceService);
  });

  it("remembers the last five vaults, newest first", async () => {
    for (const p of ["/a", "/b", "/c", "/d", "/e", "/f"])
      await workspace.openFolder(p, { openDefaultPage: false });
    expect(settings.recentVaults()).toEqual(["/f", "/e", "/d", "/c", "/b"]);
    await workspace.openFolder("/c", { openDefaultPage: false });
    expect(settings.recentVaults()[0]).toBe("/c");
  });

  it("restores the last note and the panel layout of a vault", async () => {
    await workspace.openFolder("/a");
    files.add("/a/other.md");
    await doc.open("/a/other.md");
    await flush();
    settings.backlinksVisible.set(true);
    settings.outlineVisible.set(true);
    settings.sidebarVisible.set(false);

    await workspace.openFolder("/b");
    await flush();
    // A vault opened for the first time keeps the current panels, with the sidebar shown.
    expect(settings.sidebarVisible()).toBe(true);
    expect(path()).toBe("/b/home.md");
    settings.backlinksVisible.set(false);
    settings.outlineVisible.set(false);

    await workspace.openFolder("/a");
    expect(path()).toBe("/a/other.md");
    expect(settings.backlinksVisible()).toBe(true);
    expect(settings.outlineVisible()).toBe(true);
    expect(settings.sidebarVisible()).toBe(false);
  });

  describe("tabs of a vault", () => {
    const layout = {
      panes: [
        {
          tabs: [
            { path: "/b/other.md", history: ["/b/other.md"], index: 0, editing: false, line: null },
          ],
          active: 0,
        },
      ],
      focused: 0,
      ratio: 0.5,
    };

    function withTabs(restore: () => Promise<boolean>) {
      const fake = {
        panes: signal([]),
        focusedId: signal(0),
        reset: vi.fn(),
        restore: vi.fn(restore),
        snapshot: vi.fn(() => layout),
      };
      TestBed.resetTestingModule();
      TestBed.configureTestingModule({
        providers: [
          { provide: DocumentService, useValue: doc },
          { provide: TabsService, useValue: fake },
        ],
      });
      settings = TestBed.inject(SettingsService);
      workspace = TestBed.inject(WorkspaceService);
      settings.noteVaultOpened("/b");
      settings.rememberVaultState("/b", {
        note: "/b/other.md",
        sidebar: true,
        backlinks: false,
        outline: false,
        layout,
      });
      return fake;
    }

    it("opens the stored tabs instead of one note", async () => {
      const tabs = withTabs(async () => true);
      await workspace.openFolder("/b");
      expect(tabs.reset).toHaveBeenCalled();
      expect(tabs.restore).toHaveBeenCalledWith(layout);
      expect(doc.open).not.toHaveBeenCalled();
    });

    it("opens the remembered note when no tab can be restored", async () => {
      files.add("/b/other.md");
      const tabs = withTabs(async () => false);
      await workspace.openFolder("/b");
      expect(tabs.restore).toHaveBeenCalled();
      expect(doc.open).toHaveBeenCalledWith("/b/other.md");
    });

    it("stores the tabs with the vault state", async () => {
      withTabs(async () => true);
      await workspace.openFolder("/c", { openDefaultPage: false });
      await doc.open("/c/home.md");
      await flush();
      expect(settings.vaultStates()["/c"]?.layout).toEqual(layout);
    });
  });

  it("falls back to the default page when the remembered note is gone", async () => {
    await workspace.openFolder("/a");
    await doc.open("/a/gone.md");
    await flush();
    await workspace.openFolder("/b");
    await workspace.openFolder("/a");
    expect(path()).toBe("/a/home.md");
  });

  it("removes a vault that no longer exists and reports it", async () => {
    await workspace.openFolder("/a", { openDefaultPage: false });
    await workspace.openFolder("/b", { openDefaultPage: false });
    dirs.delete("/a");
    await expect(workspace.openRecent("/a")).resolves.toBe(false);
    expect(settings.recentVaults()).toEqual(["/b"]);
    expect(settings.vaultStates()["/a"]).toBeUndefined();
  });

  it("prunes every missing vault", async () => {
    for (const p of ["/a", "/b", "/c"]) await workspace.openFolder(p, { openDefaultPage: false });
    dirs.delete("/a");
    dirs.delete("/c");
    const picker = TestBed.inject(RecentPickerService);
    await picker.prune();
    expect(settings.recentVaults()).toEqual(["/b"]);
    expect(picker.notice()).toBe(missingMessage(["/c", "/a"]));
  });

  it("switches to a chosen vault, or reports one that is gone", async () => {
    await workspace.openFolder("/a", { openDefaultPage: false });
    await workspace.openFolder("/b", { openDefaultPage: false });
    const picker = TestBed.inject(RecentPickerService);
    await picker.choose("/a");
    expect(workspace.root()).toBe("/a");

    dirs.delete("/b");
    await picker.choose("/b");
    expect(workspace.root()).toBe("/a");
    expect(picker.notice()).toBe(missingMessage(["/b"]));
    expect(settings.recentVaults()).toEqual(["/a"]);
  });
});

describe("vault changes made outside the app", () => {
  let workspace: WorkspaceService;
  let reload: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    localStorage.clear();
    window.matchMedia = vi.fn().mockReturnValue({ matches: false, addEventListener: vi.fn() });
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [{ provide: DocumentService, useValue: { path: signal(null), open: vi.fn() } }],
    });
    workspace = TestBed.inject(WorkspaceService);
    reload = vi.spyOn(workspace, "reloadTree").mockResolvedValue(undefined);
  });

  it("reloads the tree when a file or folder appeared, went or moved", async () => {
    for (const kind of ["create", "remove", "rename"] as const) {
      reload.mockClear();
      await workspace.onVaultChanged([{ path: "a.md", kind }]);
      expect(reload, kind).toHaveBeenCalledTimes(1);
    }
  });

  it("leaves the tree alone for modified files (the own autosave)", async () => {
    await workspace.onVaultChanged([{ path: "a.md", kind: "modify" }]);
    await workspace.onVaultChanged([]);
    expect(reload).not.toHaveBeenCalled();
  });

  it("runs overlapping reloads once more instead of in parallel", async () => {
    let release!: () => void;
    reload.mockImplementationOnce(() => new Promise<void>((r) => (release = r)));
    const first = workspace.onVaultChanged([{ path: "a.md", kind: "create" }]);
    const second = workspace.onVaultChanged([{ path: "b.md", kind: "create" }]);
    const third = workspace.onVaultChanged([{ path: "c.md", kind: "remove" }]);
    expect(reload).toHaveBeenCalledTimes(1);
    release();
    await Promise.all([first, second, third]);
    expect(reload).toHaveBeenCalledTimes(2);
  });
});

// @vitest-environment jsdom
import "@angular/compiler";
import { signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { BrowserTestingModule, platformBrowserTesting } from "@angular/platform-browser/testing";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

import { GitStatus, HistoryEntry, backend } from "../file/backend";
import { DocumentService } from "../file/document.service";
import { IndexService } from "../index/index.service";
import { WorkspaceService } from "../workspace/workspace.service";
import { GitService } from "./git.service";
import { HistoryService, PAGE_SIZE, relativeTo } from "./history.service";

function entry(n: number, extra: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    id: `c${n}`,
    author: "A",
    time: 1000 + n,
    message: `m${n}`,
    path: "a.md",
    parent: `c${n - 1}`,
    parentPath: "a.md",
    ...extra,
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("relativeTo", () => {
  it("strips the vault root and refuses files outside it", () => {
    expect(relativeTo("/vault", "/vault/dir/a.md")).toBe("dir/a.md");
    expect(relativeTo("/vault/", "/vault/a.md")).toBe("a.md");
    expect(relativeTo("/vault", "/other/a.md")).toBeNull();
    expect(relativeTo("/vault", "/vault2/a.md")).toBeNull();
  });
});

describe("HistoryService", () => {
  const path = signal<string | null>("/vault/a.md");
  const status = signal<GitStatus | null>(null);
  const revision = signal(0);
  let history: HistoryService;
  let log: ReturnType<typeof vi.spyOn>;
  let version: ReturnType<typeof vi.spyOn>;

  beforeAll(() => {
    TestBed.initTestEnvironment(BrowserTestingModule, platformBrowserTesting());
  });

  beforeEach(() => {
    vi.restoreAllMocks();
    path.set("/vault/a.md");
    status.set({ branch: "main", changes: [], ahead: 0, behind: 0 });
    revision.set(0);
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        { provide: DocumentService, useValue: { path } },
        { provide: WorkspaceService, useValue: { vaultRoot: signal("/vault") } },
        { provide: IndexService, useValue: { revision } },
        { provide: GitService, useValue: { status, available: () => status() !== null } },
      ],
    });
    log = vi.spyOn(backend, "gitNoteHistory").mockResolvedValue([entry(2), entry(1, { parent: null })]);
    version = vi.spyOn(backend, "gitNoteVersion").mockImplementation(async (_p, rev) => `text@${rev}`);
    history = TestBed.inject(HistoryService);
  });

  async function ready() {
    TestBed.tick();
    await flush();
  }

  it("lists the commits of the open note", async () => {
    await ready();
    expect(log).toHaveBeenCalledWith("a.md", 0, PAGE_SIZE);
    expect(history.timeline().map((t) => t.id)).toEqual(["c2", "c1"]);
    expect(history.exhausted()).toBe(true);
  });

  it("puts the uncommitted state first when the note has changes", async () => {
    status.set({ branch: "main", changes: [{ path: "a.md", kind: "modified" }], ahead: 0, behind: 0 });
    await ready();
    expect(history.timeline().map((t) => t.id)).toEqual([null, "c2", "c1"]);
    expect(history.timeline()[0].message).toBe("Uncommitted changes");
  });

  it("has no history without a note or a repository", async () => {
    path.set(null);
    await ready();
    expect(history.notePath()).toBeNull();
    expect(log).not.toHaveBeenCalled();
    path.set("/elsewhere/a.md");
    expect(history.notePath()).toBeNull();
  });

  it("loads older pages with the count of loaded entries as offset", async () => {
    const page = Array.from({ length: PAGE_SIZE }, (_, i) => entry(1000 - i));
    log.mockResolvedValueOnce(page).mockResolvedValueOnce([entry(5)]);
    await ready();
    expect(history.exhausted()).toBe(false);
    await history.loadMore();
    expect(log).toHaveBeenLastCalledWith("a.md", PAGE_SIZE, PAGE_SIZE);
    expect(history.commits().length).toBe(PAGE_SIZE + 1);
    expect(history.exhausted()).toBe(true);
    await history.loadMore();
    expect(log).toHaveBeenCalledTimes(2);
  });

  it("shows the change of one commit against its parent", async () => {
    await ready();
    await history.select(history.timeline()[0]);
    expect(history.comparison()).toMatchObject({ oldText: "text@c1", newText: "text@c2", newLabel: "c2" });
  });

  it("shows a first commit against an empty note", async () => {
    await ready();
    await history.select(history.timeline()[1]);
    expect(history.comparison()?.oldText).toBe("");
    expect(history.comparison()?.newText).toBe("text@c1");
  });

  it("reads the old name of a renamed note for the parent side", async () => {
    log.mockResolvedValue([entry(2, { path: "b.md", parentPath: "a.md" })]);
    await ready();
    await history.reload();
    await history.select(history.timeline()[0]);
    expect(version).toHaveBeenCalledWith("a.md", "c1");
    expect(version).toHaveBeenCalledWith("b.md", "c2");
  });

  it("compares two selected versions, older on the old side, in any click order", async () => {
    await ready();
    const [newer, older] = history.timeline();
    await history.select(older);
    await history.select(newer);
    expect(history.comparison()).toMatchObject({ oldText: "text@c1", newText: "text@c2" });
    // Clicking a selected row deselects it.
    await history.select(newer);
    expect(history.selection()).toEqual(["c1"]);
  });

  it("compares the uncommitted state with HEAD, and with the disk text", async () => {
    status.set({ branch: "main", changes: [{ path: "a.md", kind: "modified" }], ahead: 0, behind: 0 });
    await ready();
    await history.select(history.timeline()[0]);
    expect(history.comparison()).toMatchObject({ oldText: "text@c2", newText: "text@null", newLabel: "uncommitted" });
  });

  it("reports a failing log", async () => {
    log.mockRejectedValue(new Error("boom"));
    await ready();
    await history.reload();
    expect(history.error()).toContain("boom");
  });
});

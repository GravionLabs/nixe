// @vitest-environment jsdom
import "@angular/compiler";
import { signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { BrowserTestingModule, platformBrowserTesting } from "@angular/platform-browser/testing";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

import type { GitChange } from "../file/backend";
import { backend } from "../file/backend";
import { DocumentService } from "../file/document.service";
import { WorkspaceService } from "../workspace/workspace.service";
import { ChangesService } from "./changes.service";
import { GitService } from "./git.service";

const list: GitChange[] = [
  { path: "a.md", kind: "modified" },
  { path: "dir/b.md", kind: "added" },
  { path: "gone.md", kind: "deleted" },
];
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("ChangesService", () => {
  const lastPull = signal<{ from: string } | null>(null);
  const path = signal<string | null>(null);
  const root = signal<string | null>("/vault");
  let service: ChangesService;
  let between: ReturnType<typeof vi.spyOn>;

  beforeAll(() => {
    TestBed.initTestEnvironment(BrowserTestingModule, platformBrowserTesting());
  });

  beforeEach(() => {
    vi.restoreAllMocks();
    lastPull.set(null);
    path.set(null);
    root.set("/vault");
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        { provide: GitService, useValue: { lastPull } },
        { provide: DocumentService, useValue: { path } },
        { provide: WorkspaceService, useValue: { vaultRoot: root } },
      ],
    });
    between = vi.spyOn(backend, "gitChangesBetween").mockResolvedValue(list);
    vi.spyOn(backend, "gitNoteVersion").mockImplementation(async (_p, rev) =>
      rev === "HEAD" ? "new" : "old",
    );
    service = TestBed.inject(ChangesService);
    TestBed.tick();
  });

  async function pull(from = "c1") {
    lastPull.set({ from });
    TestBed.tick();
    await flush();
  }

  it("lists the notes of a pull and marks the ones that still exist until opened", async () => {
    await pull();
    expect(between).toHaveBeenCalledWith("c1");
    expect(service.pulled()).toEqual(list);
    expect([...service.unseenPaths()].sort()).toEqual(["/vault/a.md", "/vault/dir/b.md"]);
    path.set("/vault/a.md");
    TestBed.tick();
    expect([...service.unseenPaths()]).toEqual(["/vault/dir/b.md"]);
    expect(service.pulled()).toHaveLength(3);
  });

  it("shows nothing for a pull whose diff cannot be read", async () => {
    between.mockRejectedValue("boom");
    await pull();
    expect(service.pulled()).toEqual([]);
  });

  it("forgets the pull when another vault opens", async () => {
    await pull();
    root.set("/other");
    TestBed.tick();
    expect(service.pulled()).toEqual([]);
    expect(service.unseenPaths().size).toBe(0);
    expect(lastPull()).toBeNull();
  });

  it("lists the range of the last sync and without a sync says so", async () => {
    await service.showSync();
    expect(service.changes()).toEqual([]);
    expect(service.message()).toBe("No sync brought changes yet");
    await pull("c9");
    await service.showSync();
    expect(between).toHaveBeenLastCalledWith("c9");
    expect(service.changes()).toEqual(list);
    expect(service.message()).toBeNull();
  });

  it("resolves yesterday to the newest commit of 24 hours ago", async () => {
    const at = vi.spyOn(backend, "gitRevAt").mockResolvedValue("c5");
    await service.showYesterday(1_700_000_000_000);
    expect(at).toHaveBeenCalledWith(1_700_000_000 - 86_400);
    expect(between).toHaveBeenLastCalledWith("c5");
    expect(service.kind()).toBe("yesterday");
    expect(service.changes()).toEqual(list);
    at.mockResolvedValue(null);
    await service.showYesterday();
    expect(service.changes()).toEqual([]);
    expect(service.message()).toBe("The history starts less than a day ago");
  });

  it("lists the range of a chosen commit and reports a bad one", async () => {
    await service.showCommit(" abc123 ");
    expect(between).toHaveBeenLastCalledWith("abc123");
    expect(service.changes()).toEqual(list);
    between.mockRejectedValue("revspec 'zz' not found");
    await service.showCommit("zz");
    expect(service.changes()).toEqual([]);
    expect(service.message()).toContain("not found");
    await service.showCommit("  ");
    expect(service.message()).toBe("Enter a commit id");
  });

  it("opens and closes the diff of a changed note", async () => {
    await service.showCommit("abc");
    await service.toggle(list[0]);
    expect(service.diff()).toEqual({ path: "a.md", oldText: "old", newText: "new" });
    expect(backend.gitNoteVersion).toHaveBeenCalledWith("a.md", "abc");
    await service.toggle(list[0]);
    expect(service.selected()).toBeNull();
    expect(service.diff()).toBeNull();
  });
});

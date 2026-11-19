// @vitest-environment jsdom
import "@angular/compiler";
import { signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { BrowserTestingModule, platformBrowserTesting } from "@angular/platform-browser/testing";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

import { GitChange, ReviewBranch, backend } from "../file/backend";
import { IndexService } from "../index/index.service";
import { SettingsService } from "../settings/settings.service";
import { GitService } from "./git.service";
import { ReviewService } from "./review.service";

const branch = (name: string, tip: string): ReviewBranch => ({
  name,
  tip,
  remote: false,
  author: "Claude",
  time: 1_700_000_000,
  messages: ["tidy"],
  ahead: 1,
  notes: 1,
});
const changes: GitChange[] = [{ path: "a.md", kind: "modified" }];
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("ReviewService", () => {
  const available = signal(true);
  const status = signal<object | null>({});
  const prefix = signal("claude/");
  let service: ReviewService;
  let branches: ReturnType<typeof vi.spyOn>;

  beforeAll(() => {
    TestBed.initTestEnvironment(BrowserTestingModule, platformBrowserTesting());
  });

  beforeEach(async () => {
    vi.restoreAllMocks();
    available.set(true);
    prefix.set("claude/");
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        { provide: GitService, useValue: { available, status } },
        { provide: IndexService, useValue: { revision: signal(0) } },
        { provide: SettingsService, useValue: { reviewBranchPrefix: prefix } },
      ],
    });
    branches = vi.spyOn(backend, "gitReviewBranches").mockResolvedValue([branch("claude/a", "t1"), branch("claude/b", "t2")]);
    vi.spyOn(backend, "gitReviewChanges").mockResolvedValue({ base: "base1", changes });
    vi.spyOn(backend, "gitNoteVersion").mockImplementation(async (_p, rev) => (rev === "t1" ? "after" : "before"));
    service = TestBed.inject(ReviewService);
    TestBed.tick();
    await flush();
  });

  it("lists the branches of the configured prefix and counts them", () => {
    expect(branches).toHaveBeenCalledWith("claude/");
    expect(service.count()).toBe(2);
  });

  it("lists nothing without Git or with an empty prefix, and reads again when the prefix changes", async () => {
    prefix.set("agent/");
    TestBed.tick();
    await flush();
    expect(branches).toHaveBeenLastCalledWith("agent/");
    branches.mockClear();
    prefix.set("");
    TestBed.tick();
    await flush();
    expect(service.count()).toBe(0);
    expect(branches).not.toHaveBeenCalled();
    prefix.set("claude/");
    available.set(false);
    TestBed.tick();
    await flush();
    expect(service.count()).toBe(0);
  });

  it("reports a failing listing", async () => {
    branches.mockRejectedValue("boom");
    await service.refresh();
    expect(service.count()).toBe(0);
    expect(service.error()).toBe("boom");
  });

  it("opens a branch, shows a note's diff against the merge base and closes again", async () => {
    await service.toggle(service.branches()[0]);
    expect(backend.gitReviewChanges).toHaveBeenCalledWith("t1");
    expect(service.changes()).toEqual(changes);
    await service.select(changes[0]);
    expect(backend.gitNoteVersion).toHaveBeenCalledWith("a.md", "base1");
    expect(backend.gitNoteVersion).toHaveBeenCalledWith("a.md", "t1");
    expect(service.diff()).toEqual({ path: "a.md", oldText: "before", newText: "after" });
    await service.select(changes[0]);
    expect(service.diff()).toBeNull();
    await service.toggle(service.branches()[0]);
    expect(service.open()).toBeNull();
    expect(service.changes()).toEqual([]);
  });

  it("follows the open branch to its new tip and closes it once it is merged", async () => {
    await service.toggle(service.branches()[0]);
    branches.mockResolvedValue([branch("claude/a", "t9")]);
    await service.refresh();
    await flush();
    expect(backend.gitReviewChanges).toHaveBeenLastCalledWith("t9");
    expect(service.open()?.tip).toBe("t9");
    branches.mockResolvedValue([]);
    await service.refresh();
    expect(service.open()).toBeNull();
    expect(service.count()).toBe(0);
  });
});

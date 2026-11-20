// @vitest-environment jsdom
import "@angular/compiler";
import { signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { BrowserTestingModule, platformBrowserTesting } from "@angular/platform-browser/testing";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

import { GitChange, ReviewBranch, ReviewHunk, backend } from "../file/backend";
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
const hunk = (index: number): ReviewHunk => ({
  index,
  oldStart: index,
  oldLines: 1,
  newStart: index,
  newLines: 1,
  old: "o\n",
  new: "n\n",
});
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("ReviewService", () => {
  const available = signal(true);
  const status = signal<object | null>({});
  const prefix = signal("claude/");
  let service: ReviewService;
  let branches: ReturnType<typeof vi.spyOn>;
  const refresh = vi.fn(async () => undefined);
  let save: ReturnType<typeof vi.spyOn>;

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
        { provide: GitService, useValue: { available, status, refresh } },
        { provide: IndexService, useValue: { revision: signal(0) } },
        {
          provide: SettingsService,
          useValue: {
            reviewBranchPrefix: prefix,
            gitAuthorName: signal(" Me "),
            gitAuthorEmail: signal(""),
          },
        },
      ],
    });
    branches = vi
      .spyOn(backend, "gitReviewBranches")
      .mockResolvedValue([branch("claude/a", "t1"), branch("claude/b", "t2")]);
    vi.spyOn(backend, "gitReviewChanges").mockResolvedValue({ base: "base1", changes });
    vi.spyOn(backend, "gitNoteVersion").mockImplementation(async (_p, rev) =>
      rev === "t1" ? "after" : "before",
    );
    vi.spyOn(backend, "gitReviewHunks").mockResolvedValue([hunk(0), hunk(1)]);
    vi.spyOn(backend, "gitReviewStateLoad").mockResolvedValue(null);
    save = vi.spyOn(backend, "gitReviewStateSave").mockResolvedValue(undefined);
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

  describe("decisions (#109)", () => {
    const open = async () => service.toggle(service.branches()[0]);

    it("loads the hunks of every note and starts with everything rejected", async () => {
      await open();
      expect(backend.gitReviewHunks).toHaveBeenCalledWith("t1", "a.md");
      expect(service.stateOf("a.md")).toBe("rejected");
      expect(service.accepted()).toBe(0);
    });

    it("accepts a note, a single hunk and rejects again", async () => {
      await open();
      service.setHunk("a.md", 1, true);
      expect(service.stateOf("a.md")).toBe("partial");
      expect(service.isAccepted("a.md", 1)).toBe(true);
      expect(service.isAccepted("a.md", 0)).toBe(false);
      service.setNote("a.md", true);
      expect(service.stateOf("a.md")).toBe("accepted");
      expect(service.accepted()).toBe(1);
      service.setNote("a.md", false);
      expect(service.stateOf("a.md")).toBe("rejected");
    });

    it("edits an accepted hunk and keeps the edit through accept; the undo takes it back", async () => {
      await open();
      service.editHunk("a.md", 0, "mine\n");
      expect(service.isAccepted("a.md", 0)).toBe(true);
      expect(service.editedText("a.md", 0)).toBe("mine\n");
      service.setHunk("a.md", 0, true);
      expect(service.editedText("a.md", 0)).toBe("mine\n");
      service.resetHunk("a.md", 0);
      expect(service.editedText("a.md", 0)).toBeUndefined();
      service.editHunk("a.md", 0, "x");
      service.setHunk("a.md", 0, false);
      expect(service.editedText("a.md", 0)).toBeUndefined();
    });

    it("saves the decisions and takes them back after a restart, but not for a moved branch", async () => {
      await open();
      service.setHunk("a.md", 0, true);
      const saved = save.mock.calls.at(-1)!;
      expect(saved[0]).toBe("claude/a");
      const content = saved[1] as string;
      expect(JSON.parse(content).tip).toBe("t1");
      service.close();
      vi.spyOn(backend, "gitReviewStateLoad").mockResolvedValue(content);
      await open();
      expect(service.isAccepted("a.md", 0)).toBe(true);
      service.close();
      vi.spyOn(backend, "gitReviewStateLoad").mockResolvedValue(content.replace('"t1"', '"old"'));
      await open();
      expect(service.isAccepted("a.md", 0)).toBe(false);
    });

    it("finishes: sends the accepted hunks, deletes the branch and closes it", async () => {
      const finish = vi.spyOn(backend, "gitReviewFinish").mockResolvedValue({
        commit: "c1",
        applied: ["a.md"],
        conflicts: [],
        branchDeleted: true,
        warning: null,
      });
      await open();
      service.setHunk("a.md", 1, true);
      service.editHunk("a.md", 1, "edited\n");
      await service.finish();
      expect(finish).toHaveBeenCalledWith(
        "claude/a",
        "t1",
        [{ path: "a.md", accepted: false, hunks: [{ index: 1, accept: true, text: "edited\n" }] }],
        true,
        "Me",
        null,
      );
      expect(service.open()).toBeNull();
      expect(service.result()).toBe("1 note from claude/a merged");
      expect(refresh).toHaveBeenCalled();
    });

    it("finishing with everything rejected deletes the branch without changes", async () => {
      vi.spyOn(backend, "gitReviewFinish").mockResolvedValue({
        commit: null,
        applied: [],
        conflicts: [],
        branchDeleted: true,
        warning: "the branch stays on origin: offline",
      });
      await open();
      await service.finish();
      expect(service.result()).toBe(
        "Nothing accepted: claude/a deleted without changes. the branch stays on origin: offline",
      );
    });

    it("keeps the review open and lists the conflicts, then finishes with the resolution", async () => {
      const finish = vi
        .spyOn(backend, "gitReviewFinish")
        .mockResolvedValueOnce({
          commit: null,
          applied: [],
          conflicts: [{ path: "a.md", mine: "m", branch: "b" }],
          branchDeleted: false,
          warning: null,
        })
        .mockResolvedValueOnce({
          commit: "c",
          applied: [],
          conflicts: [],
          branchDeleted: true,
          warning: null,
        });
      await open();
      service.setNote("a.md", true);
      await service.finish();
      expect(service.open()).not.toBeNull();
      expect(service.conflicts()).toEqual([{ path: "a.md", mine: "m", branch: "b" }]);
      service.resolve("a.md", "mine");
      await service.finish();
      expect(finish.mock.calls[1][2][0].resolve).toBe("mine");
      expect(service.open()).toBeNull();
    });

    it("reports a failing finish and stays open", async () => {
      vi.spyOn(backend, "gitReviewFinish").mockRejectedValue("no author");
      await open();
      await service.finish();
      expect(service.error()).toBe("no author");
      expect(service.open()).not.toBeNull();
      expect(service.finishing()).toBe(false);
    });
  });
});

// @vitest-environment jsdom
// The Git view in the demo (#403): status, commit, sync and the branch to review.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadApp } from "./harness";

vi.mock("@tauri-apps/api/core", () => import("./mock"));
vi.mock("@tauri-apps/api/event", () => import("./mock"));

let app: ReturnType<typeof loadApp>;
beforeEach(async () => {
  app = loadApp();
});

describe("Git view of the demo", () => {
  it("shows the open changes of the working tree", async () => {
    const status = await app.backend.gitVaultStatus();
    expect(status).toMatchObject({ branch: "main", hasRemote: true, ahead: 1, behind: 0 });
    expect(status!.changes).toEqual([
      { path: "Ideas.md", kind: "modified" },
      { path: "Daily/2026-11-21.md", kind: "added", untracked: true },
    ]);
  });

  it("commits the open changes and leaves the view clean", async () => {
    const id = await app.backend.gitVaultCommit("daily: write", null, null);
    expect(id).toHaveLength(40);
    expect((await app.backend.gitVaultStatus())!.changes).toEqual([]);
    expect((await app.backend.gitVaultLog(0, 1))[0]).toMatchObject({ id, message: "daily: write" });
  });

  it("commits only the notes it is given", async () => {
    await app.backend.gitVaultCommit(null, null, null, ["Ideas.md"]);
    expect((await app.backend.gitVaultStatus())!.changes.map((c) => c.path)).toEqual([
      "Daily/2026-11-21.md",
    ]);
  });

  it("syncs, pushes and has nothing ahead afterwards", async () => {
    const report = await app.backend.gitVaultSync(null, null);
    expect(report).toMatchObject({ committed: true, pushed: true, conflicts: [] });
    const status = await app.backend.gitVaultStatus();
    expect(status).toMatchObject({ ahead: 0, changes: [] });
  });

  it("tracks the token of a host", async () => {
    expect(await app.backend.gitTokenStatus("github.com")).toBe(false);
    await app.backend.gitTokenSet("github.com", "secret");
    expect(await app.backend.gitTokenStatus("github.com")).toBe(true);
    await app.backend.gitTokenDelete("github.com");
    expect(await app.backend.gitTokenStatus("github.com")).toBe(false);
  });

  it("lists the branch to review with its notes and hunks", async () => {
    const [branch] = await app.backend.gitReviewBranches("claude/");
    expect(branch).toMatchObject({ name: "claude/tidy-inbox", ahead: 2, notes: 2 });
    expect(await app.backend.gitReviewBranches("other/")).toEqual([]);
    const changes = await app.backend.gitReviewChanges(branch!.tip);
    expect(changes.changes.map((c) => c.path)).toEqual(["Home.md", "Projects/Roadmap.md"]);
    const [hunk] = await app.backend.gitReviewHunks(branch!.tip, "Home.md");
    expect(hunk).toMatchObject({ index: 0, old: "- [[Ideas]]: things to try\n" });
    expect(hunk!.new).toContain("try next");
  });

  it("applies the accepted changes of the review and deletes the branch", async () => {
    const [branch] = await app.backend.gitReviewBranches("claude/");
    const outcome = await app.backend.gitReviewFinish(
      branch!.name,
      branch!.tip,
      [
        { path: "Home.md", accepted: false, hunks: [{ index: 0, accept: true }] },
        { path: "Projects/Roadmap.md", accepted: true, hunks: [] },
      ],
      true,
      null,
      null,
    );
    expect(outcome).toMatchObject({
      applied: ["Home.md", "Projects/Roadmap.md"],
      conflicts: [],
      branchDeleted: true,
    });
    expect(outcome.commit).not.toBeNull();
    expect(await app.backend.readTextFile("/demo/Notes/Home.md")).toContain("try next");
    expect(await app.backend.gitReviewBranches("claude/")).toEqual([]);
  });

  it("keeps the unfinished decisions of a branch", async () => {
    expect(await app.backend.gitReviewStateLoad("claude/tidy-inbox")).toBeNull();
    await app.backend.gitReviewStateSave("claude/tidy-inbox", "{}");
    expect(await app.backend.gitReviewStateLoad("claude/tidy-inbox")).toBe("{}");
    await app.backend.gitReviewStateSave("claude/tidy-inbox", null);
    expect(await app.backend.gitReviewStateLoad("claude/tidy-inbox")).toBeNull();
  });

  it("calls no command nobody answered", () => {
    expect(window.__demoFailures).toBeUndefined();
  });
});

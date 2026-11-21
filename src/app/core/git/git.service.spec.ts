// @vitest-environment jsdom
import "@angular/compiler";
import { signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { BrowserTestingModule, platformBrowserTesting } from "@angular/platform-browser/testing";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

import type { GitStatus } from "../file/backend";
import { backend } from "../file/backend";
import { IndexService } from "../index/index.service";
import { SettingsService } from "../settings/settings.service";
import { WorkspaceService } from "../workspace/workspace.service";
import { GitService, describeSync, explainSyncError } from "./git.service";

const status: GitStatus = {
  branch: "main",
  changes: [{ path: "a.md", kind: "modified" }],
  ahead: 1,
  behind: 0,
  hasRemote: true,
};

describe("GitService", () => {
  const vaultRoot = signal<string | null>("/vault");
  const revision = signal(0);
  const name = signal("");
  const email = signal("");
  let git: GitService;

  beforeAll(() => {
    TestBed.initTestEnvironment(BrowserTestingModule, platformBrowserTesting());
  });

  beforeEach(() => {
    vaultRoot.set("/vault");
    revision.set(0);
    name.set("");
    email.set("");
    vi.restoreAllMocks();
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        { provide: WorkspaceService, useValue: { vaultRoot } },
        { provide: IndexService, useValue: { revision } },
        { provide: SettingsService, useValue: { gitAuthorName: name, gitAuthorEmail: email } },
      ],
    });
    vi.spyOn(backend, "gitVaultStatus").mockResolvedValue(status);
    git = TestBed.inject(GitService);
  });

  it("reads the status of a vault with a repository", async () => {
    await git.refresh();
    expect(git.status()).toEqual(status);
    expect(git.available()).toBe(true);
  });

  it("keeps the status object when a refresh reads the same state (#289)", async () => {
    await git.refresh();
    const first = git.status();
    vi.spyOn(backend, "gitVaultStatus").mockResolvedValue(structuredClone(status));
    await git.refresh();
    expect(git.status()).toBe(first);
  });

  it("shows no Git for a vault without a repository", async () => {
    vi.spyOn(backend, "gitVaultStatus").mockResolvedValue(null);
    await git.refresh();
    expect(git.status()).toBeNull();
    expect(git.available()).toBe(false);
  });

  it("clears the state when no vault is open or the status fails", async () => {
    await git.refresh();
    expect(git.available()).toBe(true);
    vi.spyOn(backend, "gitVaultStatus").mockRejectedValue(new Error("x"));
    await git.refresh();
    expect(git.status()).toBeNull();
    vaultRoot.set(null);
    await git.refresh();
    expect(git.available()).toBe(false);
  });

  it("commits with the author of the settings and reads the status again", async () => {
    name.set(" Ann ");
    email.set("ann@example.com");
    const commit = vi.spyOn(backend, "gitVaultCommit").mockResolvedValue("abc");
    await git.commit("  my message ");
    expect(commit).toHaveBeenCalledWith("my message", "Ann", "ann@example.com");
    expect(backend.gitVaultStatus).toHaveBeenCalled();
    expect(git.committing()).toBe(false);
  });

  it("passes no message and no author when they are empty", async () => {
    const commit = vi.spyOn(backend, "gitVaultCommit").mockResolvedValue("abc");
    await git.commit("  ");
    expect(commit).toHaveBeenCalledWith(null, null, null);
  });

  it("rethrows a failed commit and still resets the state", async () => {
    vi.spyOn(backend, "gitVaultCommit").mockRejectedValue("nothing to commit");
    await expect(git.commit("m")).rejects.toBe("nothing to commit");
    expect(git.committing()).toBe(false);
  });

  describe("saveAndSync", () => {
    const report = { committed: false, pulled: false, pushed: true, conflicts: [] };

    it("saves the changes with the message, then syncs", async () => {
      await git.refresh();
      const commit = vi.spyOn(backend, "gitVaultCommit").mockResolvedValue("abc");
      const sync = vi.spyOn(backend, "gitVaultSync").mockResolvedValue(report);
      await git.saveAndSync("note");
      expect(commit).toHaveBeenCalledWith("note", null, null);
      expect(sync).toHaveBeenCalled();
      expect(git.lastSynced()).not.toBeNull();
    });

    it("only saves when there is no remote", async () => {
      vi.mocked(backend.gitVaultStatus).mockResolvedValue({ ...status, hasRemote: false });
      await git.refresh();
      const commit = vi.spyOn(backend, "gitVaultCommit").mockResolvedValue("abc");
      const sync = vi.spyOn(backend, "gitVaultSync").mockResolvedValue(report);
      await git.saveAndSync("");
      expect(commit).toHaveBeenCalledWith(null, null, null);
      expect(sync).not.toHaveBeenCalled();
    });

    it("only syncs when nothing changed", async () => {
      vi.mocked(backend.gitVaultStatus).mockResolvedValue({ ...status, changes: [] });
      await git.refresh();
      const commit = vi.spyOn(backend, "gitVaultCommit").mockResolvedValue("abc");
      const sync = vi.spyOn(backend, "gitVaultSync").mockResolvedValue(report);
      await git.saveAndSync("");
      expect(commit).not.toHaveBeenCalled();
      expect(sync).toHaveBeenCalled();
    });
  });

  describe("sync", () => {
    beforeEach(async () => {
      await git.refresh();
    });

    it("syncs with the author of the settings and reports the result", async () => {
      name.set(" Ann ");
      email.set("ann@example.com");
      let seen = "";
      const sync = vi.spyOn(backend, "gitVaultSync").mockImplementation(() => {
        seen = git.syncState().phase;
        return Promise.resolve({ committed: true, pulled: true, pushed: true, conflicts: [] });
      });
      await git.sync();
      expect(seen).toBe("syncing");
      expect(sync).toHaveBeenCalledWith("Ann", "ann@example.com");
      expect(git.syncState()).toEqual({
        phase: "done",
        message: "Synced (saved, received, sent)",
      });
    });

    it("remembers where HEAD was before a pull that brought changes", async () => {
      const report = {
        committed: false,
        pulled: true,
        pushed: false,
        pulledFrom: "abc",
        conflicts: [],
      };
      const sync = vi.spyOn(backend, "gitVaultSync").mockResolvedValue(report);
      await git.sync();
      expect(git.lastPull()).toEqual({ from: "abc" });
      sync.mockResolvedValue({ ...report, pulled: false, pulledFrom: null });
      await git.sync();
      expect(git.lastPull()).toEqual({ from: "abc" });
    });

    it("says when nothing had to be done", async () => {
      vi.spyOn(backend, "gitVaultSync").mockResolvedValue({
        committed: false,
        pulled: false,
        pushed: false,
        conflicts: [],
      });
      await git.sync();
      expect(git.syncState().message).toBe("Everything is synced");
    });

    it("shows a failure and reads the status again", async () => {
      vi.spyOn(backend, "gitVaultSync").mockRejectedValue("sync stopped: conflict");
      const calls = vi.mocked(backend.gitVaultStatus).mock.calls.length;
      await git.sync();
      expect(git.syncState()).toEqual({
        phase: "error",
        message:
          "Sync failed: Some notes were changed in two places and could not be joined. Nothing is lost; try again.",
        detail: "sync stopped: conflict",
      });
      expect(vi.mocked(backend.gitVaultStatus).mock.calls.length).toBeGreaterThan(calls);
    });

    it("asks for a token and syncs again with it", async () => {
      vi.spyOn(backend, "gitTokenSet").mockResolvedValue();
      const sync = vi
        .spyOn(backend, "gitVaultSync")
        .mockRejectedValueOnce("auth-required:github.com")
        .mockResolvedValue({ committed: false, pulled: true, pushed: false, conflicts: [] });
      const run = git.sync();
      await vi.waitFor(() => expect(git.tokenPrompt()).not.toBeNull());
      await git.saveToken("ghp_x");
      await run;
      expect(sync).toHaveBeenCalledTimes(2);
      expect(git.syncState().message).toBe("Synced (received)");
    });

    it("explains a cancelled token prompt", async () => {
      vi.spyOn(backend, "gitVaultSync").mockRejectedValue("auth-failed:github.com");
      const run = git.sync();
      await vi.waitFor(() => expect(git.tokenPrompt()).not.toBeNull());
      git.cancelTokenPrompt();
      await run;
      expect(git.syncState().phase).toBe("error");
      expect(git.syncState().message).toContain("access token");
    });

    it("ignores a second sync while one runs and does nothing without a repository", async () => {
      let finish!: () => void;
      const sync = vi
        .spyOn(backend, "gitVaultSync")
        .mockReturnValue(
          new Promise(
            (resolve) =>
              (finish = () =>
                resolve({ committed: false, pulled: false, pushed: false, conflicts: [] })),
          ),
        );
      const first = git.sync();
      await git.sync();
      finish();
      await first;
      expect(sync).toHaveBeenCalledTimes(1);
      vaultRoot.set(null);
      await git.refresh();
      await git.sync();
      expect(sync).toHaveBeenCalledTimes(1);
    });
  });

  describe("automatic sync", () => {
    beforeEach(async () => {
      await git.refresh();
    });

    it("shows an error once and not again on the next interval", async () => {
      vi.spyOn(backend, "gitVaultSync").mockRejectedValue("network down");
      await git.sync({ auto: true });
      expect(git.syncState()).toEqual({
        phase: "error",
        message:
          "Sync failed: The server could not be reached. Check your connection and try again.",
        detail: "network down",
      });
      git.syncState.set({ phase: "idle", message: "" });
      await git.sync({ auto: true });
      expect(git.syncState()).toEqual({ phase: "idle", message: "" });
    });

    it("shows a different error and an error again after a success", async () => {
      const sync = vi.spyOn(backend, "gitVaultSync").mockRejectedValue("a");
      await git.sync({ auto: true });
      sync.mockRejectedValue("b");
      await git.sync({ auto: true });
      expect(git.syncState().detail).toBe("b");
      sync.mockResolvedValue({ committed: false, pulled: false, pushed: false, conflicts: [] });
      await git.sync({ auto: true });
      expect(git.syncState().phase).toBe("done");
      sync.mockRejectedValue("b");
      await git.sync({ auto: true });
      expect(git.syncState()).toMatchObject({ phase: "error", detail: "b" });
    });

    it("never asks for a token", async () => {
      vi.spyOn(backend, "gitVaultSync").mockRejectedValue("auth-required:github.com");
      await git.sync({ auto: true });
      expect(git.tokenPrompt()).toBeNull();
      expect(git.syncState().message).toContain("access token");
    });
  });

  describe("access token", () => {
    beforeEach(() => {
      vi.spyOn(backend, "gitTokenStatus").mockResolvedValue(false);
    });

    it("reads whether a token is stored", async () => {
      vi.spyOn(backend, "gitTokenStatus").mockResolvedValue(true);
      await git.refreshToken();
      expect(backend.gitTokenStatus).toHaveBeenCalledWith("github.com");
      expect(git.tokenStored()).toBe(true);
    });

    it("stores, replaces and deletes the token", async () => {
      const set = vi.spyOn(backend, "gitTokenSet").mockResolvedValue();
      const del = vi.spyOn(backend, "gitTokenDelete").mockResolvedValue();
      await git.saveToken("  ghp_new ");
      expect(set).toHaveBeenCalledWith("github.com", "ghp_new");
      expect(git.tokenStored()).toBe(true);
      await git.deleteToken();
      expect(del).toHaveBeenCalledWith("github.com");
      expect(git.tokenStored()).toBe(false);
    });

    it("refuses an empty token", async () => {
      const set = vi.spyOn(backend, "gitTokenSet").mockResolvedValue();
      await expect(git.saveToken("  ")).rejects.toThrow("the token is empty");
      expect(set).not.toHaveBeenCalled();
    });

    it("passes the result of a remote operation that needs no token", async () => {
      await expect(git.runRemote(() => Promise.resolve(7))).resolves.toBe(7);
      expect(git.tokenPrompt()).toBeNull();
    });

    it("rethrows other errors without asking", async () => {
      await expect(git.runRemote(() => Promise.reject("network down"))).rejects.toBe(
        "network down",
      );
      expect(git.tokenPrompt()).toBeNull();
    });

    it("asks for a token when none is stored and retries with it", async () => {
      vi.spyOn(backend, "gitTokenSet").mockResolvedValue();
      const op = vi
        .fn()
        .mockRejectedValueOnce("auth-required:github.com")
        .mockResolvedValue("done");
      const run = git.runRemote(op);
      await vi.waitFor(() => expect(git.tokenPrompt()).toEqual({ reason: "required" }));
      await git.saveToken("ghp_x");
      await expect(run).resolves.toBe("done");
      expect(op).toHaveBeenCalledTimes(2);
      expect(git.tokenPrompt()).toBeNull();
    });

    it("asks again when the token is rejected", async () => {
      vi.spyOn(backend, "gitTokenSet").mockResolvedValue();
      const op = vi
        .fn()
        .mockRejectedValueOnce("auth-failed:github.com")
        .mockRejectedValueOnce("auth-failed:github.com")
        .mockResolvedValue("done");
      const run = git.runRemote(op);
      await vi.waitFor(() => expect(git.tokenPrompt()).toEqual({ reason: "failed" }));
      await git.saveToken("bad");
      await vi.waitFor(() => expect(op).toHaveBeenCalledTimes(2));
      await vi.waitFor(() => expect(git.tokenPrompt()).toEqual({ reason: "failed" }));
      await git.saveToken("good");
      await expect(run).resolves.toBe("done");
    });

    it("fails with the original error when the prompt is cancelled", async () => {
      const run = git.runRemote(() => Promise.reject("auth-required:github.com"));
      await vi.waitFor(() => expect(git.tokenPrompt()).not.toBeNull());
      git.cancelTokenPrompt();
      await expect(run).rejects.toBe("auth-required:github.com");
      expect(git.tokenPrompt()).toBeNull();
    });
  });
});

describe("explainSyncError", () => {
  it("says what happened and what to do, without Git words", () => {
    expect(explainSyncError("auth-failed:github.com")).toContain("access token");
    expect(explainSyncError("could not resolve host")).toContain("could not be reached");
    expect(explainSyncError("no author: set user.name")).toContain("name and email");
    expect(explainSyncError("no remote configured")).toContain("Connect");
    const generic = explainSyncError("fatal: object 3f2a is corrupt");
    expect(generic).not.toContain("fatal");
    expect(generic).toContain("try again");
  });
});

describe("describeSync", () => {
  it("names the notes that kept both versions", () => {
    const report = { committed: false, pulled: true, pushed: true, conflicts: ["a.md"] };
    expect(describeSync(report)).toBe(
      "Synced (received, sent); 1 note changed on both sides, both versions kept",
    );
    expect(describeSync({ ...report, conflicts: ["a.md", "b.md"] })).toContain("2 notes changed");
    expect(describeSync({ ...report, conflicts: [] })).toBe("Synced (received, sent)");
  });
});

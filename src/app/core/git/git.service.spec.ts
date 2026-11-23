// @vitest-environment jsdom
import "@angular/compiler";
import { signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { BrowserTestingModule, platformBrowserTesting } from "@angular/platform-browser/testing";
import { listen } from "@tauri-apps/api/event";
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
  const enterprise = signal("");
  let git: GitService;

  beforeAll(() => {
    TestBed.initTestEnvironment(BrowserTestingModule, platformBrowserTesting());
  });

  beforeEach(() => {
    vaultRoot.set("/vault");
    revision.set(0);
    name.set("");
    email.set("");
    enterprise.set("");
    vi.restoreAllMocks();
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        { provide: WorkspaceService, useValue: { vaultRoot } },
        { provide: IndexService, useValue: { revision } },
        {
          provide: SettingsService,
          useValue: {
            gitAuthorName: name,
            gitAuthorEmail: email,
            gitEnterpriseHost: enterprise,
          },
        },
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

  it("reads the missing .gitignore entries and clears them without a repository (#443)", async () => {
    const missing = vi.spyOn(backend, "gitGitignoreMissing").mockResolvedValue([".trash/"]);
    await git.refresh();
    expect(git.missingIgnores()).toEqual([".trash/"]);
    vi.spyOn(backend, "gitVaultStatus").mockResolvedValue(null);
    await git.refresh();
    expect(git.missingIgnores()).toEqual([]);
    missing.mockRejectedValue(new Error("x"));
    vi.spyOn(backend, "gitVaultStatus").mockResolvedValue(status);
    await git.refresh();
    expect(git.missingIgnores()).toEqual([]);
  });

  it("adds the entries and reads again; dismissing hides the hint (#443)", async () => {
    vi.spyOn(backend, "gitGitignoreMissing").mockResolvedValue([".trash/"]);
    await git.refresh();
    const add = vi.spyOn(backend, "gitGitignoreAdd").mockResolvedValue([".trash/"]);
    vi.spyOn(backend, "gitGitignoreMissing").mockResolvedValue([]);
    await git.addMissingIgnores();
    expect(add).toHaveBeenCalled();
    expect(git.missingIgnores()).toEqual([]);
    vi.spyOn(backend, "gitGitignoreMissing").mockResolvedValue([".trash/"]);
    await git.refresh();
    const dismiss = vi.spyOn(backend, "gitGitignoreDismiss").mockResolvedValue(undefined);
    await git.dismissIgnoreHint();
    expect(dismiss).toHaveBeenCalled();
    expect(git.missingIgnores()).toEqual([]);
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
    expect(commit).toHaveBeenCalledWith("my message", "Ann", "ann@example.com", null);
    expect(backend.gitVaultStatus).toHaveBeenCalled();
    expect(git.committing()).toBe(false);
  });

  it("passes no message and no author when they are empty", async () => {
    const commit = vi.spyOn(backend, "gitVaultCommit").mockResolvedValue("abc");
    await git.commit("  ");
    expect(commit).toHaveBeenCalledWith(null, null, null, null);
  });

  it("rethrows a failed commit and still resets the state", async () => {
    vi.spyOn(backend, "gitVaultCommit").mockRejectedValue("nothing to commit");
    await expect(git.commit("m")).rejects.toBe("nothing to commit");
    expect(git.committing()).toBe(false);
  });

  describe("choosing the notes of a save", () => {
    const five: GitStatus = {
      ...status,
      changes: [
        { path: "a.md", kind: "modified" },
        { path: "b.md", kind: "added" },
        { path: "old.md", kind: "deleted", pair: "new.md" },
        { path: "new.md", kind: "added", pair: "old.md" },
        { path: "d.md", kind: "deleted" },
      ],
    };

    beforeEach(async () => {
      vi.mocked(backend.gitVaultStatus).mockResolvedValue(five);
      await git.refresh();
    });

    it("has every change checked by default", () => {
      expect(git.selection()).toBe("all");
      expect(git.selected()).toEqual(["a.md", "b.md", "old.md", "new.md", "d.md"]);
      expect(git.isChecked("a.md")).toBe(true);
    });

    it("shows the mixed state and checks or unchecks all", () => {
      git.toggle("a.md");
      expect(git.selection()).toBe("some");
      git.setAll(false);
      expect(git.selection()).toBe("none");
      expect(git.selected()).toEqual([]);
      git.setAll(true);
      expect(git.selection()).toBe("all");
    });

    it("toggles the two halves of a rename together", () => {
      git.toggle("new.md");
      expect(git.isChecked("old.md")).toBe(false);
      expect(git.selected()).toEqual(["a.md", "b.md", "d.md"]);
      git.toggle("old.md");
      expect(git.selection()).toBe("all");
    });

    it("saves only the checked notes", async () => {
      const commit = vi.spyOn(backend, "gitVaultCommit").mockResolvedValue("abc");
      git.toggle("b.md");
      git.toggle("d.md");
      await git.commit("m");
      expect(commit).toHaveBeenCalledWith("m", null, null, ["a.md", "old.md", "new.md"]);
    });

    it("refuses a save with nothing checked", async () => {
      const commit = vi.spyOn(backend, "gitVaultCommit").mockResolvedValue("abc");
      git.setAll(false);
      await expect(git.commit("m")).rejects.toThrow("no notes are chosen");
      expect(commit).not.toHaveBeenCalled();
    });

    it("keeps the choice over a refresh and checks a new change", async () => {
      git.toggle("a.md");
      vi.mocked(backend.gitVaultStatus).mockResolvedValue({
        ...five,
        changes: [...five.changes, { path: "z.md", kind: "added" }],
      });
      await git.refresh();
      expect(git.isChecked("a.md")).toBe(false);
      expect(git.isChecked("z.md")).toBe(true);
    });

    it("forgets the choice of a note that is saved or gone", async () => {
      git.toggle("a.md");
      vi.mocked(backend.gitVaultStatus).mockResolvedValue({ ...five, changes: [] });
      await git.refresh();
      vi.mocked(backend.gitVaultStatus).mockResolvedValue(five);
      await git.refresh();
      expect(git.isChecked("a.md")).toBe(true);
    });

    it("does not sync after a partial save, as a sync saves everything", async () => {
      const commit = vi.spyOn(backend, "gitVaultCommit").mockResolvedValue("abc");
      const sync = vi.spyOn(backend, "gitVaultSync");
      git.toggle("a.md");
      await git.saveAndSync("");
      expect(commit).toHaveBeenCalled();
      expect(sync).not.toHaveBeenCalled();
    });

    it("still saves and syncs everything when all are checked", async () => {
      const commit = vi.spyOn(backend, "gitVaultCommit").mockResolvedValue("abc");
      const sync = vi
        .spyOn(backend, "gitVaultSync")
        .mockResolvedValue({ committed: false, pulled: false, pushed: true, conflicts: [] });
      await git.saveAndSync("");
      expect(commit).toHaveBeenCalledWith(null, null, null, null);
      expect(sync).toHaveBeenCalled();
    });
  });

  describe("saveAndSync", () => {
    const report = { committed: false, pulled: false, pushed: true, conflicts: [] };

    it("saves the changes with the message, then syncs", async () => {
      await git.refresh();
      const commit = vi.spyOn(backend, "gitVaultCommit").mockResolvedValue("abc");
      const sync = vi.spyOn(backend, "gitVaultSync").mockResolvedValue(report);
      await git.saveAndSync("note");
      expect(commit).toHaveBeenCalledWith("note", null, null, null);
      expect(sync).toHaveBeenCalled();
      expect(git.lastSynced()).not.toBeNull();
    });

    it("only saves when there is no remote", async () => {
      vi.mocked(backend.gitVaultStatus).mockResolvedValue({ ...status, hasRemote: false });
      await git.refresh();
      const commit = vi.spyOn(backend, "gitVaultCommit").mockResolvedValue("abc");
      const sync = vi.spyOn(backend, "gitVaultSync").mockResolvedValue(report);
      await git.saveAndSync("");
      expect(commit).toHaveBeenCalledWith(null, null, null, null);
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
      expect(git.tokenStored()).toBeFalsy();
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
      await vi.waitFor(() =>
        expect(git.tokenPrompt()).toEqual({ reason: "required", host: "github.com" }),
      );
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
      await vi.waitFor(() =>
        expect(git.tokenPrompt()).toEqual({ reason: "failed", host: "github.com" }),
      );
      await git.saveToken("bad");
      await vi.waitFor(() => expect(op).toHaveBeenCalledTimes(2));
      await vi.waitFor(() =>
        expect(git.tokenPrompt()).toEqual({ reason: "failed", host: "github.com" }),
      );
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

  describe("sign in with gh", () => {
    it("is offered only when gh is installed", async () => {
      vi.spyOn(backend, "gitProviderAvailable").mockResolvedValue(false);
      await git.refreshGh();
      expect(git.ghAvailable()).toBe(false);
      vi.spyOn(backend, "gitProviderAvailable").mockResolvedValue(true);
      await git.refreshGh();
      expect(git.ghAvailable()).toBe(true);
    });

    it("lists github.com and the configured Enterprise host", () => {
      expect(git.hosts()).toEqual(["github.com"]);
      enterprise.set(" GHE.example.com ");
      expect(git.hosts()).toEqual(["github.com", "ghe.example.com"]);
    });

    it("sends the Enterprise host to the backend", async () => {
      const send = vi.spyOn(backend, "gitSetHosts").mockResolvedValue();
      enterprise.set("ghe.example.com");
      TestBed.tick();
      await vi.waitFor(() => expect(send).toHaveBeenCalledWith(["ghe.example.com"]));
    });

    it("signs in, refreshes the token state and retries a waiting operation", async () => {
      vi.spyOn(backend, "gitTokenStatus").mockResolvedValue(true);
      const login = vi.spyOn(backend, "gitProviderLogin").mockResolvedValue();
      const op = vi
        .fn()
        .mockRejectedValueOnce("auth-required:ghe.example.com")
        .mockResolvedValue("done");
      const run = git.runRemote(op);
      await vi.waitFor(() => expect(git.tokenPrompt()?.host).toBe("ghe.example.com"));
      await git.signInWithGh();
      await expect(run).resolves.toBe("done");
      expect(login).toHaveBeenCalledWith("ghe.example.com");
      expect(git.tokenStored()).toBe(true);
      expect(git.ghError()).toBe("");
      expect(git.ghSigningIn()).toBe(false);
    });

    it("tells that the token of a signed-in gh was taken over, then clears the notice", async () => {
      vi.useFakeTimers();
      try {
        vi.spyOn(backend, "gitTokenStatus").mockResolvedValue(true);
        vi.spyOn(backend, "gitProviderLogin").mockResolvedValue("taken-over");
        await git.signInWithGh("github.com");
        expect(git.ghNotice()).toContain("taken over");
        expect(git.ghError()).toBe("");
        vi.advanceTimersByTime(7000);
        expect(git.ghNotice()).toBe("");
      } finally {
        vi.useRealTimers();
      }
    });

    it("tells that the web login finished", async () => {
      vi.spyOn(backend, "gitTokenStatus").mockResolvedValue(true);
      vi.spyOn(backend, "gitProviderLogin").mockResolvedValue("logged-in");
      await git.signInWithGh("github.com");
      expect(git.ghNotice()).toBe("Signed in to github.com with the GitHub CLI.");
    });

    it("shows an error and no notice when gh is missing or the keychain fails", async () => {
      const login = vi.spyOn(backend, "gitProviderLogin");
      login.mockRejectedValue("The GitHub CLI (gh) is not installed.");
      await git.signInWithGh("github.com");
      expect(git.ghError()).toContain("not installed");
      expect(git.ghNotice()).toBe("");
      login.mockRejectedValue("no secret service");
      await git.signInWithGh("github.com");
      expect(git.ghError()).toBe("no secret service");
      expect(git.ghNotice()).toBe("");
    });

    it("shows the code while the login runs and clears it afterwards", async () => {
      let onCode: ((e: { payload: string }) => void) | undefined;
      vi.mocked(listen).mockImplementation((async (_e: string, cb: typeof onCode) => {
        onCode = cb;
        return () => undefined;
      }) as never);
      let finish!: () => void;
      vi.spyOn(backend, "gitProviderLogin").mockReturnValue(new Promise((r) => (finish = r)));
      vi.spyOn(backend, "gitTokenStatus").mockResolvedValue(true);
      const done = git.signInWithGh("github.com");
      await vi.waitFor(() => expect(onCode).toBeDefined());
      onCode!({ payload: "ABCD-1234" });
      expect(git.ghCode()).toBe("ABCD-1234");
      expect(git.ghSigningIn()).toBe(true);
      finish();
      await done;
      expect(git.ghCode()).toBeNull();
    });

    it("keeps quiet on a cancel and shows any other failure", async () => {
      const login = vi.spyOn(backend, "gitProviderLogin");
      login.mockRejectedValue("cancelled");
      await git.signInWithGh("github.com");
      expect(git.ghError()).toBe("");
      login.mockRejectedValue("The GitHub CLI (gh) is not installed.");
      await git.signInWithGh("github.com");
      expect(git.ghError()).toContain("not installed");
      expect(git.tokenStored()).toBeFalsy();
    });

    it("stores a typed token under the host that asked", async () => {
      const set = vi.spyOn(backend, "gitTokenSet").mockResolvedValue();
      const run = git.runRemote(() => Promise.reject("auth-required:ghe.example.com"));
      run.catch(() => undefined);
      await vi.waitFor(() => expect(git.tokenPrompt()?.host).toBe("ghe.example.com"));
      await git.saveToken("tok");
      expect(set).toHaveBeenCalledWith("ghe.example.com", "tok");
    });

    it("cancels through the backend", async () => {
      const cancel = vi.spyOn(backend, "gitProviderCancel").mockResolvedValue();
      await git.cancelGhSignIn();
      expect(cancel).toHaveBeenCalled();
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

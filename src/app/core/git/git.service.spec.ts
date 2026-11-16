// @vitest-environment jsdom
import "@angular/compiler";
import { signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { BrowserTestingModule, platformBrowserTesting } from "@angular/platform-browser/testing";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

import { GitStatus, backend } from "../file/backend";
import { IndexService } from "../index/index.service";
import { SettingsService } from "../settings/settings.service";
import { WorkspaceService } from "../workspace/workspace.service";
import { GitService } from "./git.service";

const status: GitStatus = {
  branch: "main",
  changes: [{ path: "a.md", kind: "modified" }],
  ahead: 1,
  behind: 0,
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

  it("shows no Git for a vault without a repository", async () => {
    vi.spyOn(backend, "gitVaultStatus").mockResolvedValue(null);
    await git.refresh();
    expect(git.status()).toBeNull();
    expect(git.available()).toBe(false);
    git.open();
    expect(git.visible()).toBe(false);
  });

  it("clears the state when no vault is open or the status fails", async () => {
    await git.refresh();
    git.open();
    expect(git.visible()).toBe(true);
    vi.spyOn(backend, "gitVaultStatus").mockRejectedValue(new Error("x"));
    await git.refresh();
    expect(git.status()).toBeNull();
    expect(git.visible()).toBe(false);
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
      await expect(git.saveToken("  ")).rejects.toThrow();
      expect(set).not.toHaveBeenCalled();
    });

    it("passes the result of a remote operation that needs no token", async () => {
      await expect(git.runRemote(() => Promise.resolve(7))).resolves.toBe(7);
      expect(git.tokenPrompt()).toBeNull();
    });

    it("rethrows other errors without asking", async () => {
      await expect(git.runRemote(() => Promise.reject("network down"))).rejects.toBe("network down");
      expect(git.tokenPrompt()).toBeNull();
    });

    it("asks for a token when none is stored and retries with it", async () => {
      vi.spyOn(backend, "gitTokenSet").mockResolvedValue();
      const op = vi.fn().mockRejectedValueOnce("auth-required:github.com").mockResolvedValue("done");
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

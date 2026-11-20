// @vitest-environment jsdom
import "@angular/compiler";
import { TestBed } from "@angular/core/testing";
import { BrowserTestingModule, platformBrowserTesting } from "@angular/platform-browser/testing";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

import type { CloneProgress } from "../file/backend";
import { backend } from "../file/backend";
import { WorkspaceService } from "../workspace/workspace.service";
import { CloneService, isCloneUrl } from "./clone.service";
import { GitService } from "./git.service";

describe("isCloneUrl", () => {
  it("accepts GitHub https urls only", () => {
    expect(isCloneUrl(" https://github.com/a/b.git ")).toBe(true);
    for (const url of [
      "",
      "https://github.com/",
      "http://github.com/a/b",
      "https://gitlab.com/a/b",
      "https://u@github.com/a/b",
      "/tmp/x",
    ]) {
      expect(isCloneUrl(url), url).toBe(false);
    }
  });
});

describe("CloneService", () => {
  const openFolder = vi.fn();
  const cancelTokenPrompt = vi.fn();
  const runRemote = vi.fn(<T>(op: () => Promise<T>) => op());
  let clone: CloneService;
  let onProgress: ((e: { payload: CloneProgress }) => void) | undefined;
  const unlisten = vi.fn();

  beforeAll(() => {
    TestBed.initTestEnvironment(BrowserTestingModule, platformBrowserTesting());
  });

  beforeEach(() => {
    vi.resetAllMocks();
    runRemote.mockImplementation((op) => op());
    openFolder.mockResolvedValue(undefined);
    vi.mocked(listen).mockImplementation((async (_event: string, cb: typeof onProgress) => {
      onProgress = cb;
      return unlisten;
    }) as never);
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        { provide: GitService, useValue: { runRemote, cancelTokenPrompt } },
        { provide: WorkspaceService, useValue: { openFolder } },
      ],
    });
    clone = TestBed.inject(CloneService);
    clone.open();
    clone.url.set("https://github.com/a/notes.git");
    clone.parent.set("/home/me");
  });

  it("needs a GitHub url and a folder", () => {
    expect(clone.canStart()).toBe(true);
    clone.url.set("nonsense");
    expect(clone.canStart()).toBe(false);
    clone.url.set("https://github.com/a/b");
    clone.parent.set("");
    expect(clone.canStart()).toBe(false);
  });

  it("takes the folder from the dialog", async () => {
    vi.mocked(open).mockResolvedValue("/chosen");
    await clone.chooseFolder();
    expect(clone.parent()).toBe("/chosen");
    vi.mocked(open).mockResolvedValue(null);
    await clone.chooseFolder();
    expect(clone.parent()).toBe("/chosen");
  });

  it("clones through the token prompt, shows progress and opens the vault", async () => {
    vi.spyOn(backend, "gitCloneVault").mockImplementation(async () => {
      onProgress?.({ payload: { received: 5, total: 10 } });
      expect(clone.cloning()).toBe(true);
      expect(clone.percent()).toBe(50);
      return "/home/me/notes";
    });
    await clone.start();
    expect(runRemote).toHaveBeenCalledOnce();
    expect(backend.gitCloneVault).toHaveBeenCalledWith(
      "https://github.com/a/notes.git",
      "/home/me",
    );
    expect(openFolder).toHaveBeenCalledWith("/home/me/notes");
    expect(clone.visible()).toBe(false);
    expect(clone.cloning()).toBe(false);
    expect(unlisten).toHaveBeenCalled();
  });

  it("keeps the dialog open and shows a failure", async () => {
    vi.spyOn(backend, "gitCloneVault").mockRejectedValue("repository not found");
    await clone.start();
    expect(clone.error()).toBe("Clone failed: repository not found");
    expect(clone.visible()).toBe(true);
    expect(clone.cloning()).toBe(false);
    expect(openFolder).not.toHaveBeenCalled();
  });

  it("explains a refused token and a cancel", async () => {
    vi.spyOn(backend, "gitCloneVault").mockRejectedValue("auth-failed:github.com");
    await clone.start();
    expect(clone.error()).toBe("GitHub needs a valid access token");
    vi.spyOn(backend, "gitCloneVault").mockRejectedValue("cancelled");
    await clone.start();
    expect(clone.error()).toBe("Clone cancelled");
    expect(openFolder).not.toHaveBeenCalled();
  });

  it("cancels the running clone and a waiting token prompt", async () => {
    const cancel = vi.spyOn(backend, "gitCloneCancel").mockResolvedValue(undefined);
    let reject!: (e: string) => void;
    vi.spyOn(backend, "gitCloneVault").mockReturnValue(new Promise((_, r) => (reject = r)));
    const running = clone.start();
    await vi.waitFor(() => expect(clone.cloning()).toBe(true));
    await clone.close();
    expect(cancel).toHaveBeenCalled();
    expect(cancelTokenPrompt).toHaveBeenCalled();
    expect(clone.visible()).toBe(false);
    reject("cancelled");
    await running;
    expect(clone.error()).toBe("Clone cancelled");
  });

  it("does not ask the backend to cancel when nothing runs", async () => {
    const cancel = vi.spyOn(backend, "gitCloneCancel").mockResolvedValue(undefined);
    await clone.close();
    expect(cancel).not.toHaveBeenCalled();
    expect(clone.visible()).toBe(false);
  });

  it("reports a vault that does not open", async () => {
    vi.spyOn(backend, "gitCloneVault").mockResolvedValue("/home/me/notes");
    openFolder.mockRejectedValue(new Error("boom"));
    await clone.start();
    expect(clone.error()).toBe("Clone failed: boom");
    expect(clone.visible()).toBe(true);
  });
});

// @vitest-environment jsdom
import "@angular/compiler";
import { TestBed } from "@angular/core/testing";
import { BrowserTestingModule, platformBrowserTesting } from "@angular/platform-browser/testing";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import { GitService } from "../../core/git/git.service";
import { GitSpikeComponent } from "./git-spike.component";

describe("GitSpikeComponent", () => {
  const git = {
    runRemote: vi.fn((op: () => Promise<unknown>) => op()),
    saveToken: vi.fn(),
    refreshToken: vi.fn(),
    tokenStored: vi.fn(),
    tokenPrompt: vi.fn(),
  };

  beforeAll(() => {
    TestBed.initTestEnvironment(BrowserTestingModule, platformBrowserTesting());
  });

  beforeEach(() => {
    invoke.mockReset();
    git.runRemote.mockClear();
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ providers: [{ provide: GitService, useValue: git }] });
  });

  function create() {
    return { componentInstance: TestBed.runInInjectionContext(() => new GitSpikeComponent()) };
  }

  it("runs clone and push through the token prompt", async () => {
    invoke.mockResolvedValue(1);
    const c = create().componentInstance as any;
    await c.clone("u");
    await c.cmd("git_push");
    expect(git.runRemote).toHaveBeenCalledTimes(2);
  });

  it("clones into the vault directory and logs the duration", async () => {
    invoke.mockResolvedValue(42);
    const fixture = create();
    await (fixture.componentInstance as any).run("clone", () => (fixture.componentInstance as any).clone("u"));
    expect(invoke).toHaveBeenCalledWith("git_clone", { url: "u" });
    expect(fixture.componentInstance["log"]()).toContain("clone took 42 ms");
  });

  it("logs a failure instead of throwing", async () => {
    invoke.mockImplementation(async () => { throw new Error("bad credentials"); });
    const fixture = create();
    const c = fixture.componentInstance as any;
    await c.run("push", () => c.cmd("git_push"));
    expect(fixture.componentInstance["log"]()).toContain("push: FAILED Error: bad credentials");
  });
});

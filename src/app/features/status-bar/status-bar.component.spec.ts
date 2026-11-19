// @vitest-environment jsdom
import "@angular/compiler";
import { signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { BrowserTestingModule, platformBrowserTesting } from "@angular/platform-browser/testing";
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

import { GitStatus } from "../../core/file/backend";
import { GitService } from "../../core/git/git.service";
import { ShellService } from "../../core/shell/shell.service";
import { StatusBarComponent } from "./status-bar.component";

function render(status: GitStatus | null, syncState = { phase: "idle", message: "" }) {
  const sync = vi.fn();
  const show = vi.fn();
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      { provide: GitService, useValue: { status: signal(status), sync, syncState: signal(syncState) } },
      { provide: ShellService, useValue: { show } },
    ],
  });
  const fixture = TestBed.createComponent(StatusBarComponent);
  fixture.detectChanges();
  return { el: fixture.nativeElement as HTMLElement, show, sync };
}

describe("StatusBarComponent", () => {
  beforeAll(() => {
    TestBed.initTestEnvironment(BrowserTestingModule, platformBrowserTesting());
  });

  it("shows branch, changed files and ahead/behind", () => {
    const { el } = render({ branch: "main", changes: [{ path: "a.md", kind: "added" }], ahead: 2, behind: 3 });
    expect(el.textContent).toContain("main");
    expect(el.textContent).toContain("1 changed");
    expect(el.textContent).toContain("↑2 ↓3");
  });

  it("shows nothing without a repository", () => {
    expect(render(null).el.querySelector("button")).toBeNull();
  });

  it("shows the Git view in the sidebar", () => {
    const status: GitStatus = { branch: null, changes: [], ahead: 0, behind: 0 };
    const r = render(status);
    r.el.querySelector("button")!.click();
    expect(r.show).toHaveBeenCalledWith("git");
    expect(r.el.textContent).toContain("detached HEAD");
  });

  it("syncs from the button and shows the result", () => {
    const status: GitStatus = { branch: "main", changes: [], ahead: 0, behind: 0 };
    const done = render(status, { phase: "done", message: "Already in sync" });
    done.el.querySelector<HTMLButtonElement>(".sync-button")!.click();
    expect(done.sync).toHaveBeenCalled();
    expect(done.el.querySelector(".result")!.textContent).toBe("Already in sync");
  });

  it("disables the button while syncing and marks an error", () => {
    const status: GitStatus = { branch: "main", changes: [], ahead: 0, behind: 0 };
    expect(render(status, { phase: "syncing", message: "Syncing…" }).el.querySelector<HTMLButtonElement>(".sync-button")!.disabled).toBe(true);
    const failed = render(status, { phase: "error", message: "Sync failed: x" });
    expect(failed.el.querySelector(".result.error")).not.toBeNull();
  });

  it("has no sync button without a repository", () => {
    expect(render(null).el.querySelector(".sync-button")).toBeNull();
  });
});

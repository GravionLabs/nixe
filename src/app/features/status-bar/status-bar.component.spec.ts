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
import { StatusBarComponent } from "./status-bar.component";

function render(status: GitStatus | null, visible = false) {
  const open = vi.fn();
  const close = vi.fn();
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [{ provide: GitService, useValue: { status: signal(status), visible: signal(visible), open, close } }],
  });
  const fixture = TestBed.createComponent(StatusBarComponent);
  fixture.detectChanges();
  return { el: fixture.nativeElement as HTMLElement, open, close };
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

  it("toggles the panel", () => {
    const status: GitStatus = { branch: null, changes: [], ahead: 0, behind: 0 };
    const closed = render(status, false);
    closed.el.querySelector("button")!.click();
    expect(closed.open).toHaveBeenCalled();
    const shown = render(status, true);
    shown.el.querySelector("button")!.click();
    expect(shown.close).toHaveBeenCalled();
    expect(shown.el.textContent).toContain("detached HEAD");
  });
});

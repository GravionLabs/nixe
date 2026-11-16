// @vitest-environment jsdom
import "@angular/compiler";
import { readFileSync } from "node:fs";
import { signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { BrowserTestingModule, platformBrowserTesting } from "@angular/platform-browser/testing";
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

import { GitStatus } from "../../core/file/backend";
import { DocumentService } from "../../core/file/document.service";
import { GitService } from "../../core/git/git.service";
import { SettingsService } from "../../core/settings/settings.service";
import { WorkspaceService } from "../../core/workspace/workspace.service";
import { GitComponent } from "./git.component";

const status: GitStatus = {
  branch: "main",
  changes: [
    { path: "a.md", kind: "modified" },
    { path: "new/b.md", kind: "added" },
    { path: "gone.md", kind: "deleted" },
  ],
  ahead: 2,
  behind: 1,
};

function render(value: GitStatus, commit = vi.fn().mockResolvedValue(undefined)) {
  const open = vi.fn().mockResolvedValue(undefined);
  const close = vi.fn();
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      { provide: GitService, useValue: { status: signal(value), committing: signal(false), commit, close } },
      { provide: SettingsService, useValue: { gitAuthorName: signal(""), gitAuthorEmail: signal("") } },
      { provide: DocumentService, useValue: { open } },
      { provide: WorkspaceService, useValue: { vaultRoot: signal("/vault") } },
    ],
  });
  TestBed.overrideComponent(GitComponent, {
    set: {
      templateUrl: undefined,
      styleUrl: undefined,
      template: readFileSync("src/app/features/git/git.component.html", "utf8"),
    },
  });
  const fixture = TestBed.createComponent(GitComponent);
  const errors: string[] = [];
  fixture.componentInstance.error.subscribe((e) => errors.push(e));
  fixture.detectChanges();
  return { fixture, el: fixture.nativeElement as HTMLElement, open, close, commit, errors };
}

describe("GitComponent", () => {
  beforeAll(() => {
    TestBed.initTestEnvironment(BrowserTestingModule, platformBrowserTesting());
  });

  it("lists changed, added and deleted notes with the branch", () => {
    const { el } = render(status);
    expect(el.querySelector(".branch")?.textContent).toContain("main");
    expect(el.querySelector(".branch")?.textContent).toContain("↑2 ↓1");
    const kinds = [...el.querySelectorAll(".kind")].map((k) => k.textContent);
    expect(kinds).toEqual(["M", "A", "D"]);
    expect(el.querySelector(".count")?.textContent).toBe("3");
  });

  it("opens a changed note but not a deleted one", () => {
    const { el, open } = render(status);
    const buttons = [...el.querySelectorAll<HTMLButtonElement>("section button")];
    expect(buttons[2].disabled).toBe(true);
    buttons[1].click();
    expect(open).toHaveBeenCalledWith("/vault/new/b.md");
  });

  it("commits with the typed message", async () => {
    const { el, commit, fixture } = render(status);
    const input = el.querySelector<HTMLInputElement>("form input[type=text]")!;
    input.value = "my message";
    el.querySelector("form")!.dispatchEvent(new Event("submit", { cancelable: true }));
    await fixture.whenStable();
    expect(commit).toHaveBeenCalledWith("my message");
  });

  it("reports a failed commit and disables the button without changes", async () => {
    const failing = vi.fn().mockRejectedValue("nothing to commit");
    const { el, errors, fixture } = render(status, failing);
    el.querySelector("form")!.dispatchEvent(new Event("submit", { cancelable: true }));
    await fixture.whenStable();
    expect(errors).toEqual(["nothing to commit"]);

    const clean = render({ ...status, changes: [] });
    expect(clean.el.querySelector<HTMLButtonElement>("button.primary")!.disabled).toBe(true);
    expect(clean.el.textContent).toContain("No changes");
  });
});

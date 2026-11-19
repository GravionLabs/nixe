// @vitest-environment jsdom
import "@angular/compiler";
import { readFileSync } from "node:fs";
import { NO_ERRORS_SCHEMA, signal } from "@angular/core";
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

function render(
  value: GitStatus,
  commit = vi.fn().mockResolvedValue(undefined),
  token: { stored?: boolean; prompt?: { reason: "required" | "failed" } | null } = {},
) {
  const saveToken = vi.fn().mockResolvedValue(undefined);
  const deleteToken = vi.fn().mockResolvedValue(undefined);
  const cancelTokenPrompt = vi.fn();
  const open = vi.fn().mockResolvedValue(undefined);
  const close = vi.fn();
  const settings = {
    gitAuthorName: signal(""),
    gitAuthorEmail: signal(""),
    autoSync: signal(false),
    autoSyncMinutes: signal(10),
    autoSyncOnFocus: signal(false),
    autoSyncOnQuit: signal(false),
  };
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      { provide: GitService, useValue: {
          status: signal(value),
          committing: signal(false),
          commit,
          close,
          tokenStored: signal(token.stored ?? false),
          tokenPrompt: signal(token.prompt ?? null),
          saveToken,
          deleteToken,
          cancelTokenPrompt,
        } },
      { provide: SettingsService, useValue: settings },
      { provide: DocumentService, useValue: { open } },
      { provide: WorkspaceService, useValue: { vaultRoot: signal("/vault") } },
    ],
  });
  TestBed.overrideComponent(GitComponent, {
    set: {
      imports: [],
      schemas: [NO_ERRORS_SCHEMA],
      templateUrl: undefined,
      styleUrl: undefined,
      template: readFileSync("src/app/features/git/git.component.html", "utf8"),
    },
  });
  const fixture = TestBed.createComponent(GitComponent);
  const errors: string[] = [];
  fixture.componentInstance.error.subscribe((e) => errors.push(e));
  fixture.detectChanges();
  return { settings, fixture, el: fixture.nativeElement as HTMLElement, open, close, commit, errors, saveToken, deleteToken, cancelTokenPrompt };
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

  it("turns automatic sync on and sets the interval, focus and quit options", () => {
    const { el, settings, fixture } = render(status);
    expect(el.querySelector("[aria-label='Sync interval in minutes']")).toBeNull();
    const toggle = el.querySelector<HTMLInputElement>(".auto-sync input[type=checkbox]")!;
    toggle.checked = true;
    toggle.dispatchEvent(new Event("change"));
    fixture.detectChanges();
    expect(settings.autoSync()).toBe(true);
    const minutes = el.querySelector<HTMLInputElement>("[aria-label='Sync interval in minutes']")!;
    minutes.value = "0";
    minutes.dispatchEvent(new Event("change"));
    expect(settings.autoSyncMinutes()).toBe(1);
    const [, focus, quit] = el.querySelectorAll<HTMLInputElement>(".auto-sync input[type=checkbox]");
    focus.checked = true;
    focus.dispatchEvent(new Event("change"));
    quit.checked = true;
    quit.dispatchEvent(new Event("change"));
    expect(settings.autoSyncOnFocus()).toBe(true);
    expect(settings.autoSyncOnQuit()).toBe(true);
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

  describe("access token", () => {
    const buttonByText = (el: HTMLElement, text: string) =>
      [...el.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === text);

    it("offers to save a token when none is stored", () => {
      const { el } = render(status);
      expect(el.textContent).toContain("No token stored");
      expect(buttonByText(el, "Save token")).toBeTruthy();
      expect(buttonByText(el, "Delete token")).toBeUndefined();
    });

    it("shows that a token is stored without showing it, and offers replace and delete", async () => {
      const { el, saveToken, deleteToken, fixture } = render(status, undefined, { stored: true });
      expect(el.textContent).toContain("A token is stored");
      const input = el.querySelector<HTMLInputElement>("input[type=password]")!;
      input.value = "ghp_secret";
      buttonByText(el, "Replace token")!.click();
      await fixture.whenStable();
      expect(saveToken).toHaveBeenCalledWith("ghp_secret");
      expect(input.value).toBe("");
      expect(el.textContent).not.toContain("ghp_secret");
      buttonByText(el, "Delete token")!.click();
      expect(deleteToken).toHaveBeenCalled();
    });

    it("asks for a token when a remote operation needs one", () => {
      const { el } = render(status, undefined, { prompt: { reason: "failed" } });
      expect(el.querySelector("[role=alert]")!.textContent).toContain("rejected the token");
      const required = render(status, undefined, { prompt: { reason: "required" } });
      expect(required.el.querySelector("[role=alert]")!.textContent).toContain("Enter a personal access token");
    });

    it("reports a failed save", async () => {
      const { el, errors, saveToken, fixture } = render(status);
      saveToken.mockRejectedValue("keychain locked");
      buttonByText(el, "Save token")!.click();
      await fixture.whenStable();
      expect(errors).toEqual(["keychain locked"]);
    });
  });
});

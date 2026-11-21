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

import type { GitStatus } from "../../core/file/backend";
import { DocumentService } from "../../core/file/document.service";
import { backend } from "../../core/file/backend";
import { CommandRegistry } from "../../core/commands/command-registry";
import { CompareService } from "../../core/compare/compare.service";
import { GitService } from "../../core/git/git.service";
import { ReviewService } from "../../core/git/review.service";
import { SettingsService } from "../../core/settings/settings.service";
import { EmptyStateComponent } from "../../shared/panel/empty-state.component";
import { NoteRowComponent } from "../../shared/panel/note-row.component";
import { PanelSectionComponent } from "../../shared/panel/panel-section.component";
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
  hasRemote: true,
};

function render(
  value: GitStatus,
  commit = vi.fn().mockResolvedValue(undefined),
  token: { stored?: boolean; prompt?: { reason: "required" | "failed" } | null } = {},
  extra: {
    sync?: { phase: string; message: string; detail?: string };
    reviewCount?: number;
    status?: GitStatus | null;
  } = {},
) {
  localStorage.setItem("nixe.panel-section.git-settings", "1");
  const sync = vi.fn().mockResolvedValue(undefined);
  const compareOpen = vi.fn();
  const execute = vi.fn();
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
      {
        provide: GitService,
        useValue: {
          status: signal(extra.status === undefined ? value : extra.status),
          committing: signal(false),
          saveAndSync: commit,
          sync,
          lastSynced: signal<number | null>(null),
          syncState: signal(extra.sync ?? { phase: "idle", message: "" }),
          close,
          tokenStored: signal(token.stored ?? false),
          tokenPrompt: signal(token.prompt ?? null),
          saveToken,
          deleteToken,
          cancelTokenPrompt,
        },
      },
      { provide: SettingsService, useValue: settings },
      { provide: ReviewService, useValue: { count: signal(extra.reviewCount ?? 0) } },
      { provide: CompareService, useValue: { open: compareOpen } },
      { provide: CommandRegistry, useValue: { execute } },
      { provide: DocumentService, useValue: { open } },
      { provide: WorkspaceService, useValue: { vaultRoot: signal("/vault") } },
    ],
  });
  TestBed.overrideComponent(GitComponent, {
    set: {
      imports: [PanelSectionComponent, NoteRowComponent, EmptyStateComponent],
      schemas: [NO_ERRORS_SCHEMA],
      templateUrl: undefined,
      styleUrl: undefined,
      template: readFileSync("src/app/features/git/git.component.html", "utf8"),
    },
  });
  const fixture = TestBed.createComponent(GitComponent);
  const errors: string[] = [];
  fixture.componentInstance.failed.subscribe((e) => errors.push(e));
  fixture.detectChanges();
  return {
    settings,
    fixture,
    el: fixture.nativeElement as HTMLElement,
    open,
    close,
    commit,
    sync,
    compareOpen,
    execute,
    errors,
    saveToken,
    deleteToken,
    cancelTokenPrompt,
  };
}

describe("GitComponent", () => {
  beforeAll(() => {
    TestBed.initTestEnvironment(BrowserTestingModule, platformBrowserTesting());
  });

  it("says the state in one sentence with the branch small and the counts as tooltip", () => {
    const { el } = render(status);
    expect(el.querySelector(".state")?.textContent).toBe("3 changes not saved yet");
    const branch = el.querySelector(".branch")!;
    expect(branch.textContent).toContain("main");
    expect(branch.textContent).not.toContain("↑");
    expect(branch.getAttribute("title")).toBe("Branch main · 2 to send · 1 to receive");
    const kinds = [...el.querySelectorAll("[role=img]")].map((k) => k.getAttribute("title"));
    expect(kinds).toEqual(["Changed", "New", "Deleted"]);
    expect(el.querySelector(".count")?.textContent).toBe("3");
    expect(el.textContent).not.toMatch(/commit|push|pull/i);
  });

  it("syncs from the header button, which waits while a sync runs or without a remote", () => {
    const { el, sync } = render(status);
    const button = el.querySelector<HTMLButtonElement>("button.sync")!;
    expect(button.textContent?.trim()).toBe("Sync now");
    button.click();
    expect(sync).toHaveBeenCalled();
    const busy = render(status, undefined, {}, { sync: { phase: "syncing", message: "" } });
    expect(busy.el.querySelector<HTMLButtonElement>("button.sync")!.disabled).toBe(true);
    const local = render({ ...status, hasRemote: false });
    expect(local.el.querySelector<HTMLButtonElement>("button.sync")!.disabled).toBe(true);
  });

  it("explains a failed sync in plain words and keeps the raw text as detail", () => {
    const { el } = render(
      status,
      undefined,
      {},
      {
        sync: { phase: "error", message: "Sync failed: Try again.", detail: "fatal: boom" },
      },
    );
    expect(el.querySelector("[role=alert]")!.textContent).toContain("Sync failed: Try again.");
    expect(el.querySelector(".detail-box pre")!.textContent).toBe("fatal: boom");
    expect(el.querySelector("[role=alert]")!.textContent).not.toContain("fatal");
  });

  it("shows the review section only when a suggestion waits", () => {
    expect(render(status).el.querySelector("app-review")).toBeNull();
    expect(
      render(status, undefined, {}, { reviewCount: 1 }).el.querySelector("app-review"),
    ).not.toBeNull();
  });

  it("offers to set up a vault without Git", () => {
    const { el, execute } = render(status, undefined, {}, { status: null });
    expect(el.textContent).toContain("This vault is not connected to Git yet");
    el.querySelector<HTMLButtonElement>("app-empty-state button")!.click();
    expect(execute).toHaveBeenCalledWith("open-settings");
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
    const [, focus, quit] = el.querySelectorAll<HTMLInputElement>(
      ".auto-sync input[type=checkbox]",
    );
    focus.checked = true;
    focus.dispatchEvent(new Event("change"));
    quit.checked = true;
    quit.dispatchEvent(new Event("change"));
    expect(settings.autoSyncOnFocus()).toBe(true);
    expect(settings.autoSyncOnQuit()).toBe(true);
  });

  it("compares the saved version with now on a click and opens the note with Open", async () => {
    const version = vi
      .spyOn(backend, "gitNoteVersion")
      .mockImplementation((_p, rev) => Promise.resolve(rev === "HEAD" ? "old" : "new"));
    const { el, open, compareOpen, fixture } = render(status);
    el.querySelectorAll<HTMLButtonElement>("app-note-row .main")[0].click();
    await fixture.whenStable();
    expect(version).toHaveBeenCalledWith("a.md", "HEAD");
    expect(version).toHaveBeenCalledWith("a.md", null);
    expect(compareOpen).toHaveBeenCalledWith({
      path: "a.md",
      title: "a",
      oldLabel: "Saved version",
      newLabel: "Now",
      oldText: "old",
      newText: "new",
    });
    const opens = el.querySelectorAll<HTMLButtonElement>("button.open");
    expect(opens).toHaveLength(2); // none for the deleted note
    opens[1].click();
    expect(open).toHaveBeenCalledWith("/vault/new/b.md");
  });

  it("compares an added note against nothing and a deleted one against nothing now", async () => {
    vi.spyOn(backend, "gitNoteVersion").mockResolvedValue("text");
    const { el, compareOpen, fixture } = render(status);
    const rows = el.querySelectorAll<HTMLButtonElement>("app-note-row .main");
    rows[1].click();
    rows[2].click();
    await fixture.whenStable();
    expect(compareOpen.mock.calls[0][0]).toMatchObject({ oldText: null, newText: "text" });
    expect(compareOpen.mock.calls[1][0]).toMatchObject({ oldText: "text", newText: null });
  });

  it("saves and syncs with the typed message, the button says Save without a remote", async () => {
    const { el, commit, fixture } = render(status);
    const input = el.querySelector<HTMLInputElement>("form input[type=text]")!;
    expect(el.querySelector("form label")!.textContent).toContain("What did you change?");
    expect(el.querySelector("button.primary")!.textContent?.trim()).toBe("Save and sync");
    input.value = "my message";
    el.querySelector("form")!.dispatchEvent(new Event("submit", { cancelable: true }));
    await fixture.whenStable();
    expect(commit).toHaveBeenCalledWith("my message");
    const local = render({ ...status, hasRemote: false });
    expect(local.el.querySelector("button.primary")!.textContent?.trim()).toBe("Save");
  });

  it("reports a failed save and disables the button without changes and without a remote", async () => {
    const failing = vi.fn().mockRejectedValue("nothing to commit");
    const { el, errors, fixture } = render(status, failing);
    el.querySelector("form")!.dispatchEvent(new Event("submit", { cancelable: true }));
    await fixture.whenStable();
    expect(errors).toEqual(["nothing to commit"]);

    const clean = render({ ...status, changes: [], hasRemote: false });
    expect(clean.el.querySelector<HTMLButtonElement>("button.primary")!.disabled).toBe(true);
    expect(clean.el.textContent).toContain("Everything is saved");
  });

  describe("access token", () => {
    const buttonByText = (el: HTMLElement, text: string) =>
      [...el.querySelectorAll<HTMLButtonElement>("button")].find(
        (b) => b.textContent?.trim() === text,
      );

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
      expect(required.el.querySelector("[role=alert]")!.textContent).toContain(
        "Enter a personal access token",
      );
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

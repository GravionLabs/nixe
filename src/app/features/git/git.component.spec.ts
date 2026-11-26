// @vitest-environment jsdom
import "@angular/compiler";
import { readFileSync } from "node:fs";
import { NO_ERRORS_SCHEMA, computed, signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { BrowserTestingModule, platformBrowserTesting } from "@angular/platform-browser/testing";
import { HxList, HxListRow } from "@gravionlabs/helix-ui";
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

import type { GitStatus } from "../../core/file/backend";
import { DocumentService } from "../../core/file/document.service";
import { backend } from "../../core/file/backend";
import { CommandRegistry } from "../../core/commands/command-registry";
import { CompareService } from "../../core/compare/compare.service";
import { DiscardService } from "../../core/git/discard.service";
import { GitService } from "../../core/git/git.service";
import { ReviewService } from "../../core/git/review.service";
import { SettingsPageService } from "../../core/settings/settings-page.service";
import { EmptyStateComponent } from "../../shared/panel/empty-state.component";
import { NoteRowComponent } from "../../shared/panel/note-row.component";
import { NoteTitleComponent } from "../../shared/panel/note-title.component";
import { PanelSectionComponent } from "../../shared/panel/panel-section.component";
import { WorkspaceService } from "../../core/workspace/workspace.service";
import { GitComponent } from "./git.component";
import { pressArrow } from "../../../testing/list-keys";

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
    ignores?: string[];
    openPath?: string;
  } = {},
) {
  const sync = vi.fn().mockResolvedValue(undefined);
  const compareOpen = vi.fn();
  const execute = vi.fn();
  const open = vi.fn().mockResolvedValue(undefined);
  const close = vi.fn();
  const discard = vi.fn().mockResolvedValue(true);
  const selected = vi.fn();
  const statusValue = extra.status === undefined ? value : extra.status;
  const checkedPaths = signal(new Set((statusValue?.changes ?? []).map((c) => c.path)));
  const total = statusValue?.changes.length ?? 0;
  const selection = computed(() =>
    checkedPaths().size === total ? "all" : checkedPaths().size === 0 ? "none" : "some",
  );
  const toggle = vi.fn((p: string) => {
    const next = new Set(checkedPaths());
    if (!next.delete(p)) next.add(p);
    checkedPaths.set(next);
  });
  const setAll = vi.fn();
  const addMissingIgnores = vi.fn().mockResolvedValue(undefined);
  const dismissIgnoreHint = vi.fn().mockResolvedValue(undefined);
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      {
        provide: GitService,
        useValue: {
          status: signal(extra.status === undefined ? value : extra.status),
          committing: signal(false),
          selection,
          selected: computed(() => [...checkedPaths()]),
          isChecked: (p: string) => checkedPaths().has(p),
          toggle,
          setAll,
          saveAndSync: commit,
          sync,
          lastSynced: signal<number | null>(null),
          syncState: signal(extra.sync ?? { phase: "idle", message: "" }),
          close,
          missingIgnores: signal(extra.ignores ?? []),
          addMissingIgnores,
          dismissIgnoreHint,
          tokenStored: signal(token.stored ?? false),
          tokenPrompt: signal(token.prompt ?? null),
        },
      },
      { provide: DiscardService, useValue: { discard } },
      { provide: SettingsPageService, useValue: { select: selected } },
      { provide: ReviewService, useValue: { count: signal(extra.reviewCount ?? 0) } },
      { provide: CompareService, useValue: { open: compareOpen } },
      { provide: CommandRegistry, useValue: { execute } },
      { provide: DocumentService, useValue: { open, path: signal(extra.openPath ?? null) } },
      { provide: WorkspaceService, useValue: { vaultRoot: signal("/vault") } },
    ],
  });
  TestBed.overrideComponent(GitComponent, {
    set: {
      imports: [
        PanelSectionComponent,
        NoteRowComponent,
        NoteTitleComponent,
        HxList,
        HxListRow,
        EmptyStateComponent,
      ],
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
    selected,
    fixture,
    el: fixture.nativeElement as HTMLElement,
    open,
    close,
    discard,
    commit,
    sync,
    compareOpen,
    execute,
    errors,
    toggle,
    setAll,
    checkedPaths,
    addMissingIgnores,
    dismissIgnoreHint,
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

  it("hints at missing .gitignore entries and adds or dismisses them (#443)", async () => {
    const { el, addMissingIgnores, dismissIgnoreHint, fixture } = render(
      status,
      undefined,
      {},
      {
        ignores: [".nixe/local/", ".trash/"],
      },
    );
    const hint = el.querySelector(".ignore-hint")!;
    expect(hint.textContent).toContain(".nixe/local/, .trash/");
    const [add, dismiss] = Array.from(hint.querySelectorAll("button"));
    expect(add.textContent).toContain("Add to .gitignore");
    add.click();
    dismiss.click();
    await fixture.whenStable();
    expect(addMissingIgnores).toHaveBeenCalledOnce();
    expect(dismissIgnoreHint).toHaveBeenCalledOnce();
  });

  it("shows no .gitignore hint when nothing is missing", () => {
    const { el } = render(status);
    expect(el.querySelector(".ignore-hint")).toBeNull();
  });

  it("reports a failed .gitignore action", async () => {
    const { el, addMissingIgnores, errors, fixture } = render(
      status,
      undefined,
      {},
      {
        ignores: [".trash/"],
      },
    );
    addMissingIgnores.mockRejectedValue("denied");
    (el.querySelector(".ignore-hint button") as HTMLButtonElement).click();
    await fixture.whenStable();
    expect(errors).toEqual(["denied"]);
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
      { stored: true },
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

  it("puts a labelled checkbox on every row and on the header", () => {
    const { el, toggle, setAll, fixture } = render(status);
    const rows = [...el.querySelectorAll<HTMLInputElement>("app-note-row input[type=checkbox]")];
    expect(rows.map((r) => r.getAttribute("aria-label"))).toEqual([
      "Include a in the save",
      "Include b in the save",
      "Include gone in the save",
    ]);
    expect(rows.every((r) => r.checked)).toBe(true);
    rows[1].click();
    expect(toggle).toHaveBeenCalledWith("new/b.md");
    fixture.detectChanges();
    const head = el.querySelector<HTMLInputElement>(
      "input[aria-label='Include all changes in the save']",
    )!;
    expect(head.indeterminate).toBe(true);
    head.click();
    expect(setAll).toHaveBeenCalledWith(true);
  });

  it("names the count when not all are checked and disables Save with none", () => {
    const { el, fixture, checkedPaths } = render(status);
    const save = () => el.querySelector<HTMLButtonElement>("button.primary")!;
    expect(save().textContent?.trim()).toBe("Save and sync");
    checkedPaths.set(new Set(["a.md", "gone.md"]));
    fixture.detectChanges();
    expect(save().textContent?.trim()).toBe("Save 2 of 3");
    expect(save().disabled).toBe(false);
    checkedPaths.set(new Set());
    fixture.detectChanges();
    expect(save().disabled).toBe(true);
  });

  it("offers to set up a vault without Git", () => {
    const { el, execute } = render(status, undefined, {}, { status: null });
    expect(el.textContent).toContain("This vault is not connected to Git yet");
    el.querySelector<HTMLButtonElement>("app-empty-state button")!.click();
    expect(execute).toHaveBeenCalledWith("open-settings");
  });

  it("no longer shows the author, automatic sync or token blocks", () => {
    const { el } = render(status, undefined, { stored: true });
    expect(el.textContent).not.toMatch(/Automatic sync|Author|Access token|Save token/);
    expect(el.querySelector("input[type=password]")).toBeNull();
    expect(el.querySelector("[aria-label='Sync interval in minutes']")).toBeNull();
  });

  it("offers Discard changes on every kind of change and hands the change over", async () => {
    const { el, discard, fixture, errors } = render(status);
    const buttons = el.querySelectorAll<HTMLButtonElement>("button.discard");
    expect(buttons).toHaveLength(3);
    expect(buttons[0].textContent?.trim()).toBe("Discard changes");
    buttons[2].click();
    await fixture.whenStable();
    expect(discard).toHaveBeenCalledWith({ path: "gone.md", kind: "deleted" });
    discard.mockRejectedValueOnce("no changes to discard");
    buttons[0].click();
    await fixture.whenStable();
    expect(errors).toEqual(["no changes to discard"]);
  });

  it("compares the saved version with now on a click and opens the note with Open", async () => {
    const version = vi
      .spyOn(backend, "gitNoteVersion")
      .mockImplementation((_p, rev) => Promise.resolve(rev === "HEAD" ? "old" : "new"));
    const { el, open, compareOpen, fixture } = render(status);
    el.querySelectorAll<HTMLButtonElement>("app-note-row button[hx-list-row]")[0].click();
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
    const rows = el.querySelectorAll<HTMLButtonElement>("app-note-row button[hx-list-row]");
    rows[1].click();
    rows[2].click();
    await fixture.whenStable();
    expect(compareOpen.mock.calls[0][0]).toMatchObject({ oldText: null, newText: "text" });
    expect(compareOpen.mock.calls[1][0]).toMatchObject({ oldText: "text", newText: null });
  });

  it("marks the row of the open note as current and moves through the rows with the arrows", () => {
    const { el } = render(status, undefined, {}, { openPath: "/vault/new/b.md" });
    const rows = el.querySelectorAll<HTMLButtonElement>("app-note-row button[hx-list-row]");
    expect([...rows].map((r) => r.getAttribute("aria-current"))).toEqual([null, "true", null]);
    rows[1].focus();
    pressArrow(rows[1], "ArrowDown");
    expect(document.activeElement).toBe(rows[2]);
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

  describe("token notice", () => {
    const link = (el: HTMLElement) => el.querySelector<HTMLButtonElement>(".token-notice .link");

    it("says a missing token in one line and opens the sync settings", () => {
      const { el, execute, selected } = render(status);
      expect(el.querySelector(".token-notice")!.textContent).toContain("No access token");
      link(el)!.click();
      expect(selected).toHaveBeenCalledWith("sync");
      expect(execute).toHaveBeenCalledWith("open-settings");
    });

    it("says nothing when a token is stored or there is no remote", () => {
      expect(
        render(status, undefined, { stored: true }).el.querySelector(".token-notice"),
      ).toBeNull();
      expect(render({ ...status, hasRemote: false }).el.querySelector(".token-notice")).toBeNull();
    });

    it("tells a rejected token and a token a running sync waits for", () => {
      const failed = render(status, undefined, { stored: true, prompt: { reason: "failed" } });
      expect(failed.el.querySelector(".token-notice")!.textContent).toContain("rejected");
      expect(link(failed.el)).not.toBeNull();
      const required = render(status, undefined, { stored: true, prompt: { reason: "required" } });
      expect(required.el.querySelector(".token-notice")!.textContent).toContain("needs an access");
    });
  });
});

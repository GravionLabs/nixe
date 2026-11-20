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

import { DocumentService } from "../../core/file/document.service";
import { GitChange, ReviewBranch, ReviewConflict, ReviewHunk } from "../../core/file/backend";
import { ReviewService } from "../../core/git/review.service";
import { MarkdownService } from "../../core/markdown/markdown.service";
import { WorkspaceService } from "../../core/workspace/workspace.service";
import { ReviewComponent } from "./review.component";

const branches: ReviewBranch[] = [
  {
    name: "claude/a",
    tip: "t1",
    remote: false,
    author: "Claude",
    time: 1_700_000_000,
    messages: ["tidy inbox", "fix links"],
    ahead: 2,
    notes: 2,
  },
  {
    name: "claude/b",
    tip: "t2",
    remote: true,
    author: "Claude",
    time: 1_700_000_100,
    messages: ["more"],
    ahead: 1,
    notes: 1,
  },
];
const changes: GitChange[] = [
  { path: "a.md", kind: "modified" },
  { path: "new.md", kind: "added" },
];

function render() {
  const service = {
    branches: signal(branches),
    count: signal(2),
    error: signal<string | null>(null),
    open: signal<ReviewBranch | null>(branches[0]),
    changes: signal(changes),
    selected: signal<string | null>("a.md"),
    diff: signal({ path: "a.md", oldText: "one\ntwo", newText: "one\nthree" }),
    loading: signal(false),
    result: signal<string | null>(null),
    hunks: signal<Record<string, ReviewHunk[]>>({
      "a.md": [
        {
          index: 0,
          oldStart: 1,
          oldLines: 1,
          newStart: 1,
          newLines: 1,
          old: "two\n",
          new: "three\n",
        },
        { index: 1, oldStart: 5, oldLines: 0, newStart: 5, newLines: 1, old: "", new: "tail\n" },
      ],
    }),
    choices: signal<Record<string, { resolve?: string }>>({}),
    conflicts: signal<ReviewConflict[]>([]),
    finishing: signal(false),
    accepted: signal(1),
    stateOf: vi.fn(() => "rejected"),
    isAccepted: vi.fn((_p: string, i: number) => i === 0),
    editedText: vi.fn((_p: string, i: number) => (i === 0 ? undefined : "edited\n")),
    setNote: vi.fn(),
    setHunk: vi.fn(),
    editHunk: vi.fn(),
    resetHunk: vi.fn(),
    resolve: vi.fn(),
    finish: vi.fn(async () => undefined),
    toggle: vi.fn(),
    select: vi.fn(),
  };
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      { provide: ReviewService, useValue: service },
      { provide: MarkdownService, useValue: { render: (t: string) => `<p>${t}</p>` } },
      { provide: DocumentService, useValue: {} },
      { provide: WorkspaceService, useValue: { vaultRoot: signal("/vault") } },
    ],
  });
  TestBed.overrideComponent(ReviewComponent, {
    set: {
      templateUrl: undefined,
      styleUrl: undefined,
      template: readFileSync("src/app/features/review/review.component.html", "utf8"),
    },
  });
  const fixture = TestBed.createComponent(ReviewComponent);
  fixture.detectChanges();
  return { service, fixture, el: fixture.nativeElement as HTMLElement };
}

describe("ReviewComponent", () => {
  beforeAll(() => {
    TestBed.initTestEnvironment(BrowserTestingModule, platformBrowserTesting());
  });

  it("lists the branches with author, date, commit messages and the number of notes", () => {
    const { el } = render();
    expect(el.querySelector("h2")!.textContent).toContain("2");
    const rows = [...el.querySelectorAll(".branch")].map((b) =>
      b.textContent!.replace(/\s+/g, " ").trim(),
    );
    expect(rows[0]).toBe("claude/a Claude · 2023-11-14 22:13 · 2 notes");
    expect(rows[1]).toContain("remote");
    expect(rows[1]).toContain("1 note");
    expect(
      [...el.querySelectorAll(".messages")[0].querySelectorAll("li")].map((l) => l.textContent),
    ).toEqual(["tidy inbox", "fix links"]);
  });

  it("opens a branch and one of its notes", () => {
    const { el, service } = render();
    el.querySelectorAll<HTMLElement>(".branch")[1].click();
    expect(service.toggle).toHaveBeenCalledWith(branches[1]);
    const entries = [...el.querySelectorAll(".entry")].map((b) =>
      b.textContent!.replace(/\s+/g, " ").trim(),
    );
    expect(entries).toEqual(["Ma.mdrejected", "Anew.mdrejected"]);
    el.querySelectorAll<HTMLElement>(".entry")[1].click();
    expect(service.select).toHaveBeenCalledWith(changes[1]);
  });

  it("shows the source diff and switches to the rendered versions", () => {
    const { el, fixture } = render();
    el.querySelectorAll<HTMLElement>(".toolbar button")[1].click();
    fixture.detectChanges();
    expect(el.querySelectorAll(".diff .row.add")).toHaveLength(1);
    expect(el.querySelectorAll(".diff .row.del")).toHaveLength(1);
    el.querySelectorAll<HTMLElement>(".toolbar button")[2].click();
    fixture.detectChanges();
    expect(el.querySelector(".diff")).toBeNull();
    const md = [...el.querySelectorAll(".rendered .md")].map((m) => m.textContent);
    expect(md).toEqual(["one\ntwo", "one\nthree"]);
  });

  const button = (el: HTMLElement, label: string) =>
    [...el.querySelectorAll<HTMLElement>("button")].find(
      (b) => b.textContent!.trim() === label || b.getAttribute("aria-label") === label,
    )!;

  it("accepts or rejects a note and a hunk", () => {
    const { el, service } = render();
    expect(el.querySelectorAll(".hunk")).toHaveLength(2);
    button(el, "Accept a.md").click();
    expect(service.setNote).toHaveBeenCalledWith("a.md", true);
    button(el, "Reject a.md").click();
    expect(service.setNote).toHaveBeenCalledWith("a.md", false);
    const hunks = el.querySelectorAll<HTMLElement>(".hunk");
    (hunks[0].querySelectorAll("button")[1] as HTMLElement).click();
    expect(service.setHunk).toHaveBeenCalledWith("a.md", 0, false);
    (hunks[1].querySelectorAll("button")[0] as HTMLElement).click();
    expect(service.setHunk).toHaveBeenCalledWith("a.md", 1, true);
    expect(hunks[1].querySelector("pre.add")!.textContent).toBe("edited\n");
    expect(hunks[1].textContent).toContain("edited");
  });

  it("edits an accepted hunk before it is applied", () => {
    const { el, fixture, service } = render();
    button(el, "Edit").click();
    fixture.detectChanges();
    const area = el.querySelector<HTMLTextAreaElement>("textarea")!;
    expect(area.value).toBe("three\n");
    area.value = "four\n";
    button(el, "Apply edit").click();
    fixture.detectChanges();
    expect(service.editHunk).toHaveBeenCalledWith("a.md", 0, "four\n");
    expect(el.querySelector("textarea")).toBeNull();
  });

  it("asks before it finishes the review and deletes the branch", () => {
    const { el, fixture, service } = render();
    button(el, "Finish review").click();
    fixture.detectChanges();
    expect(service.finish).not.toHaveBeenCalled();
    expect(el.querySelector(".finish")!.textContent).toContain(
      "delete claude/a locally and on the remote",
    );
    button(el, "Cancel").click();
    fixture.detectChanges();
    expect(el.querySelector(".finish p")).toBeNull();
    button(el, "Finish review").click();
    fixture.detectChanges();
    button(el, "Confirm").click();
    expect(service.finish).toHaveBeenCalled();
  });

  it("shows both versions of a conflicting note and lets the user decide", () => {
    const { el, fixture, service } = render();
    service.conflicts.set([{ path: "a.md", mine: "mine text", branch: null }]);
    fixture.detectChanges();
    expect(el.querySelector(".conflict .mine")!.textContent).toBe("mine text");
    expect(el.querySelector(".conflict .theirs")!.textContent).toBe("(deleted)");
    button(el, "Keep mine").click();
    expect(service.resolve).toHaveBeenCalledWith("a.md", "mine");
    button(el, "Use branch version").click();
    expect(service.resolve).toHaveBeenCalledWith("a.md", "branch");
  });
});

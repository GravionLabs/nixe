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

import type { GitChange, VaultCommit } from "../../core/file/backend";
import { DocumentService } from "../../core/file/document.service";
import { ChangesService } from "../../core/git/changes.service";
import { WorkspaceService } from "../../core/workspace/workspace.service";
import { ChangesComponent } from "./changes.component";
import { pressArrow } from "../../../testing/list-keys";

const list: GitChange[] = [
  { path: "a.md", kind: "modified" },
  { path: "gone.md", kind: "deleted" },
];

function render(kind = "sync", openPath: string | null = null) {
  const open = vi.fn().mockResolvedValue(undefined);
  const service = {
    kind: signal(kind),
    changes: signal(list),
    message: signal<string | null>(null),
    loading: signal(false),
    showSync: vi.fn(),
    showYesterday: vi.fn(),
    showWeek: vi.fn(),
    chooseVersion: vi.fn(),
    showVersion: vi.fn(),
    chosen: signal<{ id: string; label: string } | null>(null),
    versions: signal<VaultCommit[]>([
      { id: "c2", author: "Ann", time: 1_700_000_000, message: "Second" },
      { id: "c1", author: "", time: 1_699_000_000, message: "" },
    ]),
    versionsError: signal<string | null>(null),
    compare: vi.fn(),
  };
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      { provide: ChangesService, useValue: service },
      { provide: DocumentService, useValue: { open, path: signal(openPath) } },
      { provide: WorkspaceService, useValue: { vaultRoot: signal("/vault") } },
    ],
  });
  TestBed.overrideComponent(ChangesComponent, {
    set: {
      templateUrl: undefined,
      styleUrl: undefined,
      template: readFileSync("src/app/features/changes/changes.component.html", "utf8"),
    },
  });
  const fixture = TestBed.createComponent(ChangesComponent);
  fixture.detectChanges();
  return { service, open, el: fixture.nativeElement as HTMLElement };
}

describe("ChangesComponent", () => {
  beforeAll(() => {
    TestBed.initTestEnvironment(BrowserTestingModule, platformBrowserTesting());
  });

  it("lists changed, added and deleted notes", () => {
    const { el } = render();
    const names = [...el.querySelectorAll("app-note-row button[hx-list-row]")].map((b) =>
      b.textContent!.replace(/\s+/g, " ").trim(),
    );
    expect(names).toEqual(["●a", "−gone"]);
    const icons = [...el.querySelectorAll("app-status-icon [role=img]")].map((i) =>
      i.getAttribute("title"),
    );
    expect(icons).toEqual(["Changed", "Deleted"]);
    expect(el.querySelector("app-note-row button[hx-list-row]")!.getAttribute("title")).toBe(
      "a.md",
    );
    expect(el.querySelector(".diff")).toBeNull();
  });

  it("offers the ranges in a dropdown and no commit id field", () => {
    const { el, service } = render();
    const select = el.querySelector<HTMLSelectElement>("select.range")!;
    expect([...select.options].map((o) => o.textContent!.trim())).toEqual([
      "Last sync",
      "Yesterday",
      "Last week",
      "Choose a version…",
    ]);
    expect(el.querySelector("input")).toBeNull();
    expect(el.querySelector(".version")).toBeNull();
    for (const value of ["sync", "yesterday", "week", "commit"]) {
      select.value = value;
      select.dispatchEvent(new Event("change"));
    }
    expect(service.showSync).toHaveBeenCalled();
    expect(service.showYesterday).toHaveBeenCalled();
    expect(service.showWeek).toHaveBeenCalled();
    expect(service.chooseVersion).toHaveBeenCalled();
  });

  it("lists the versions with date, message and author and picks one", () => {
    const { el, service } = render("commit");
    const version = el.querySelector<HTMLSelectElement>("select.version")!;
    const labels = [...version.options].map((o) => o.textContent!.replace(/\s+/g, " ").trim());
    expect(labels[1]).toContain("Second");
    expect(labels[1]).toContain("Ann");
    expect(labels[2]).toContain("(no message)");
    version.value = "c2";
    version.dispatchEvent(new Event("change"));
    expect(service.showVersion).toHaveBeenCalledWith(service.versions()[0]);
  });

  it("opens a note, but not a deleted one", () => {
    const { el, open, service } = render();
    const opens = el.querySelectorAll<HTMLElement>(".open");
    expect(opens).toHaveLength(1);
    opens[0].click();
    expect(open).toHaveBeenCalledWith("/vault/a.md");
    el.querySelectorAll<HTMLElement>("app-note-row button[hx-list-row]")[1].click();
    expect(service.compare).toHaveBeenCalledWith(list[1]);
  });

  it("marks the row of the open note as current and moves through the rows with the arrows", () => {
    const { el } = render("sync", "/vault/gone.md");
    const rows = el.querySelectorAll<HTMLButtonElement>("button[hx-list-row]");
    expect(rows[0].getAttribute("aria-current")).toBeNull();
    expect(rows[1].getAttribute("aria-current")).toBe("true");
    expect([...rows].map((r) => r.tabIndex)).toEqual([-1, 0]);
    rows[1].focus();
    pressArrow(rows[1], "ArrowUp");
    expect(document.activeElement).toBe(rows[0]);
  });
});

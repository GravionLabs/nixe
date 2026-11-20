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

import { GitChange } from "../../core/file/backend";
import { DocumentService } from "../../core/file/document.service";
import { ChangesService } from "../../core/git/changes.service";
import { WorkspaceService } from "../../core/workspace/workspace.service";
import { ChangesComponent } from "./changes.component";

const list: GitChange[] = [
  { path: "a.md", kind: "modified" },
  { path: "gone.md", kind: "deleted" },
];

function render() {
  const open = vi.fn().mockResolvedValue(undefined);
  const service = {
    kind: signal("sync"),
    changes: signal(list),
    message: signal<string | null>(null),
    loading: signal(false),
    selected: signal<string | null>("a.md"),
    diff: signal({ path: "a.md", oldText: "one\ntwo", newText: "one\nthree" }),
    showSync: vi.fn(),
    showYesterday: vi.fn(),
    showCommit: vi.fn(),
    toggle: vi.fn(),
  };
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      { provide: ChangesService, useValue: service },
      { provide: DocumentService, useValue: { open } },
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

  it("lists changed, added and deleted notes with the diff of the opened one", () => {
    const { el } = render();
    const names = [...el.querySelectorAll(".entry")].map((b) =>
      b.textContent!.replace(/\s+/g, " ").trim(),
    );
    expect(names).toEqual(["Ma.md", "Dgone.md"]);
    expect(el.querySelector(".diff")!.textContent).toContain("three");
    expect(el.querySelectorAll(".diff .row.add")).toHaveLength(1);
    expect(el.querySelectorAll(".diff .row.del")).toHaveLength(1);
  });

  it("picks the range: last sync, yesterday, a chosen commit", () => {
    const { el, service } = render();
    const buttons = el.querySelectorAll<HTMLElement>(".range button");
    buttons[0].click();
    buttons[1].click();
    expect(service.showSync).toHaveBeenCalled();
    expect(service.showYesterday).toHaveBeenCalled();
    const input = el.querySelector<HTMLInputElement>(".commit input")!;
    input.value = "abc123";
    el.querySelector<HTMLFormElement>(".commit")!.dispatchEvent(new Event("submit"));
    expect(service.showCommit).toHaveBeenCalledWith("abc123");
  });

  it("opens a note, but not a deleted one", () => {
    const { el, open, service } = render();
    const opens = el.querySelectorAll<HTMLElement>(".open");
    expect(opens).toHaveLength(1);
    opens[0].click();
    expect(open).toHaveBeenCalledWith("/vault/a.md");
    el.querySelectorAll<HTMLElement>(".entry")[1].click();
    expect(service.toggle).toHaveBeenCalledWith(list[1]);
  });
});

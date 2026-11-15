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

import { Backlink } from "../../core/file/backend";
import { DocumentService } from "../../core/file/document.service";
import { BacklinksService, BacklinksState, OutgoingLink } from "../../core/index/backlinks.service";
import { WorkspaceService } from "../../core/workspace/workspace.service";
import { BacklinksComponent } from "./backlinks.component";

const back: Backlink = {
  source: "B.md",
  heading: null,
  block: null,
  alias: null,
  kind: "link",
  line: 7,
  context: "see [[A]] here",
};
const out = (label: string, resolved: string | null): OutgoingLink => ({
  label,
  resolved,
  heading: null,
  line: 1,
  kind: "link",
});

function render(state: BacklinksState, backlinks: Backlink[], outgoing: OutgoingLink[]) {
  const open = vi.fn().mockResolvedValue(undefined);
  const refresh = vi.fn();
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      {
        provide: BacklinksService,
        useValue: {
          state: signal(state),
          backlinks: signal(backlinks),
          outgoing: signal(outgoing),
          key: signal("k"),
          refresh,
        },
      },
      { provide: DocumentService, useValue: { open } },
      { provide: WorkspaceService, useValue: { vaultRoot: signal("/vault") } },
    ],
  });
  TestBed.overrideComponent(BacklinksComponent, {
    set: {
      templateUrl: undefined,
      styleUrl: undefined,
      template: readFileSync("src/app/features/backlinks/backlinks.component.html", "utf8"),
    },
  });
  const fixture = TestBed.createComponent(BacklinksComponent);
  fixture.detectChanges();
  return { el: fixture.nativeElement as HTMLElement, open, refresh };
}

describe("BacklinksComponent", () => {
  beforeAll(() => {
    TestBed.initTestEnvironment(BrowserTestingModule, platformBrowserTesting());
  });

  it("lists backlinks with context, marks unresolved links and opens a backlink at its line", () => {
    const { el, open, refresh } = render("ready", [back], [out("C", "C.md"), out("Gone", null)]);
    expect(refresh).toHaveBeenCalled();
    expect(el.textContent).toContain("see [[A]] here");
    const buttons = el.querySelectorAll("button");
    expect(buttons[1].disabled).toBe(false);
    expect(buttons[2].disabled).toBe(true);
    expect(buttons[2].textContent).toContain("unresolved");
    buttons[0].click();
    expect(open).toHaveBeenCalledWith("/vault/B.md", { line: 7, anchor: null });
  });

  it("says so when there are no links", () => {
    const { el } = render("ready", [], []);
    expect(el.textContent).toContain("No backlinks");
    expect(el.textContent).toContain("No outgoing links");
    expect(el.querySelectorAll("button").length).toBe(0);
  });

  it("shows a loading note while the index is being built", () => {
    const { el } = render("loading", [], []);
    expect(el.textContent).toContain("Indexing the vault");
    expect(el.textContent).not.toContain("No backlinks");
  });
});

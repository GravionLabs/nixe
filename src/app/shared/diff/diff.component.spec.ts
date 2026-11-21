// @vitest-environment jsdom
import "@angular/compiler";
import { signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { BrowserTestingModule, platformBrowserTesting } from "@angular/platform-browser/testing";
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

import { MarkdownService } from "../../core/markdown/markdown.service";
import { WorkspaceService } from "../../core/workspace/workspace.service";
import { DiffComponent } from "./diff.component";

function render(
  oldText: string | null,
  newText: string | null,
  mode: "source" | "rendered",
): HTMLElement {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      { provide: MarkdownService, useValue: { render: (t: string) => `<p>${t}</p>` } },
      { provide: WorkspaceService, useValue: { vaultRoot: signal("/vault") } },
    ],
  });
  const fixture = TestBed.createComponent(DiffComponent);
  fixture.componentRef.setInput("oldText", oldText);
  fixture.componentRef.setInput("newText", newText);
  fixture.componentRef.setInput("oldLabel", "Last sync");
  fixture.componentRef.setInput("newLabel", "Now");
  fixture.componentRef.setInput("mode", mode);
  fixture.detectChanges();
  return fixture.nativeElement as HTMLElement;
}

describe("DiffComponent", () => {
  beforeAll(() => {
    TestBed.initTestEnvironment(BrowserTestingModule, platformBrowserTesting());
  });

  it("shows the line diff with word highlights in source mode", () => {
    const el = render("the quick fox", "the slow fox", "source");
    expect(el.querySelector(".row.del .word")?.textContent).toBe("quick");
    expect(el.querySelector(".row.add .word")?.textContent).toBe("slow");
    expect(el.querySelector(".rendered")).toBeNull();
  });

  it("shows both versions as rendered Markdown with their labels", () => {
    const el = render("one", "two", "rendered");
    expect([...el.querySelectorAll("h3")].map((h) => h.textContent)).toEqual(["Last sync", "Now"]);
    expect([...el.querySelectorAll(".md")].map((m) => m.textContent)).toEqual(["one", "two"]);
    expect(el.querySelector(".diff")).toBeNull();
  });

  it("says so when one side does not exist", () => {
    const added = render(null, "new", "rendered");
    expect(added.querySelectorAll(".md")).toHaveLength(1);
    expect(added.querySelector(".status")?.textContent).toContain("does not exist");
    const deleted = render("old", null, "source");
    expect(deleted.querySelector(".status")?.textContent).toContain("Now: the note does not exist");
    expect(deleted.querySelectorAll(".row.del")).toHaveLength(1);
  });

  it("does not call an existing empty note missing", () => {
    const el = render("", "text", "rendered");
    expect(el.querySelectorAll(".md")).toHaveLength(2);
    expect(el.querySelector(".status")).toBeNull();
  });

  it("says when there is no difference", () => {
    expect(render("", "", "source").textContent).toContain("No difference");
    const same = render("same", "same", "source");
    expect(same.querySelector(".row.add, .row.del")).toBeNull();
  });
});

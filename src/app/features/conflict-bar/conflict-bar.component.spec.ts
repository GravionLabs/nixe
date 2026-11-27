// @vitest-environment jsdom
import "@angular/compiler";
import { signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { BrowserTestingModule, platformBrowserTesting } from "@angular/platform-browser/testing";
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

import { ConflictService } from "../../core/git/conflict.service";
import { ConflictBarComponent } from "./conflict-bar.component";
import { ConflictMergeComponent } from "./conflict-merge.component";

const pair = { original: "/v/Note.md", copy: "/v/Note (conflict 2026-11-16 mac).md" };

function render(copy: boolean, withPair = true) {
  const service = {
    pair: signal(withPair ? pair : null),
    isCopy: () => copy,
    other: () => (copy ? pair.original : pair.copy),
    openOther: vi.fn().mockResolvedValue(undefined),
    keep: vi.fn().mockResolvedValue(undefined),
    startMerge: vi.fn().mockResolvedValue(undefined),
    merging: signal<{ mine: string; theirs: string } | null>(null),
    cancelMerge: vi.fn(),
    saveMerge: vi.fn().mockResolvedValue(undefined),
  };
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({ providers: [{ provide: ConflictService, useValue: service }] });
  TestBed.overrideComponent(ConflictMergeComponent, {
    set: { templateUrl: undefined, styleUrl: undefined, template: "" },
  });
  const fixture = TestBed.createComponent(ConflictBarComponent);
  const errors: string[] = [];
  fixture.componentInstance.failed.subscribe((e) => errors.push(e));
  fixture.detectChanges();
  return { el: fixture.nativeElement as HTMLElement, service, errors, fixture };
}

describe("ConflictBarComponent", () => {
  beforeAll(() => {
    TestBed.initTestEnvironment(BrowserTestingModule, platformBrowserTesting());
  });

  it("links the copy from the original and the original from the copy", () => {
    expect(render(false).el.querySelector("a")?.textContent).toBe(
      "Note (conflict 2026-11-16 mac).md",
    );
    expect(render(true).el.querySelector("a")?.textContent).toBe("Note.md");
  });

  it("shows nothing for a note without a conflict", () => {
    expect(render(false, false).el.querySelector(".bar")).toBeNull();
  });

  it("opens the other note and keeps one of the two", () => {
    const { el, service } = render(false);
    el.querySelector("a")!.click();
    expect(service.openOther).toHaveBeenCalled();
    const [, keepThis, keepOther] = Array.from(el.querySelectorAll("button"));
    keepThis.click();
    keepOther.click();
    expect(service.keep.mock.calls).toEqual([["this"], ["other"]]);
  });

  it("starts the merge", () => {
    const { el, service } = render(false);
    const merge = Array.from(el.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "Merge",
    )!;
    merge.click();
    expect(service.startMerge).toHaveBeenCalled();
  });

  it("reports a failed action", async () => {
    const { el, service, errors } = render(false);
    service.keep.mockRejectedValue("boom");
    el.querySelectorAll("button")[1].click();
    await new Promise((r) => setTimeout(r));
    expect(errors).toEqual(["boom"]);
  });
});

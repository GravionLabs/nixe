// @vitest-environment jsdom
import "@angular/compiler";
import { TestBed } from "@angular/core/testing";
import { BrowserTestingModule, platformBrowserTesting } from "@angular/platform-browser/testing";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { ExternalCompareComponent } from "./external-compare.component";

beforeAll(() => {
  TestBed.initTestEnvironment(BrowserTestingModule, platformBrowserTesting());
});

function render(disk: string, mine: string) {
  TestBed.resetTestingModule();
  TestBed.overrideComponent(ExternalCompareComponent, {
    set: {
      styleUrl: undefined,
    },
  });
  const fixture = TestBed.createComponent(ExternalCompareComponent);
  fixture.componentRef.setInput("disk", disk);
  fixture.componentRef.setInput("mine", mine);
  const events = { reload: vi.fn(), keep: vi.fn(), closed: vi.fn() };
  fixture.componentInstance.reload.subscribe(events.reload);
  fixture.componentInstance.keep.subscribe(events.keep);
  fixture.componentInstance.closed.subscribe(events.closed);
  fixture.detectChanges();
  return { fixture, events, el: document.body };
}

describe("ExternalCompareComponent", () => {
  it("shows the disk version as removed and the editor text as added", () => {
    const { el } = render("one\ntwo\n", "one\nthree\n");
    expect(el.querySelector(".row.del")?.textContent).toContain("two");
    expect(el.querySelector(".row.add")?.textContent).toContain("three");
    expect(el.querySelector(".stat")?.textContent).toContain("+1");
  });

  it("says when there is no difference", () => {
    const { el } = render("same\n", "same\n");
    expect(el.querySelectorAll(".row.add, .row.del")).toHaveLength(0);
  });

  it("offers the same two choices and says what each does", () => {
    const { el, events } = render("a", "b");
    const buttons = Array.from(el.querySelectorAll<HTMLButtonElement>(".choices button"));
    expect(buttons.map((b) => b.textContent?.trim())).toEqual(["Reload", "Keep mine"]);
    expect(el.querySelector(".choices")?.textContent).toContain("Discards your unsaved edits");
    expect(el.querySelector(".choices")?.textContent).toContain("Replaces the version on disk");
    buttons[0].click();
    buttons[1].click();
    expect(events.reload).toHaveBeenCalledTimes(1);
    expect(events.keep).toHaveBeenCalledTimes(1);
  });
});

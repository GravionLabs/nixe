// @vitest-environment jsdom
import "@angular/compiler";
import { TestBed } from "@angular/core/testing";
import { BrowserTestingModule, platformBrowserTesting } from "@angular/platform-browser/testing";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { ExternalCompareComponent } from "./external-compare.component";

beforeAll(() => {
  TestBed.initTestEnvironment(BrowserTestingModule, platformBrowserTesting());
});

const escape = (el: HTMLElement) =>
  el
    .querySelector("[role=dialog]")!
    .dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", keyCode: 27, bubbles: true }));
const footer = (el: HTMLElement) => [
  ...el.querySelectorAll<HTMLButtonElement>(".hx-dialog-footer button"),
];
const primary = (el: HTMLElement) =>
  footer(el).filter((b) => !b.matches(".hx-button-text, .hx-button-outlined, .hx-button-link"));

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

  it("offers the two choices and says what each does", () => {
    const { el, events } = render("a", "b");
    expect(footer(el).map((b) => b.textContent?.trim())).toEqual(["Cancel", "Reload", "Keep mine"]);
    expect(footer(el)[0].classList).toContain("hx-button-text");
    expect(footer(el)[1].classList).toContain("hx-button-danger");
    expect(el.querySelector(".choices")?.textContent).toContain("Discards your unsaved edits");
    expect(el.querySelector(".choices")?.textContent).toContain("Replaces the version on disk");
    footer(el)[1].click();
    expect(events.reload).toHaveBeenCalledTimes(1);
    expect(events.keep).not.toHaveBeenCalled();
  });

  it("keeps the editor text with the one primary button", () => {
    const { el, events } = render("a", "b");
    expect(primary(el)).toEqual([footer(el)[2]]);
    primary(el)[0].click();
    expect(events.keep).toHaveBeenCalledTimes(1);
    expect(events.reload).not.toHaveBeenCalled();
  });

  it("closes with Escape and with Cancel, without a choice", async () => {
    for (const close of [escape, (el: HTMLElement) => footer(el)[0].click()]) {
      const { el, events, fixture } = render("a", "b");
      close(el);
      await vi.waitFor(() => {
        fixture.detectChanges();
        expect(events.closed).toHaveBeenCalled();
      });
      expect(events.reload).not.toHaveBeenCalled();
      expect(events.keep).not.toHaveBeenCalled();
    }
  });
});

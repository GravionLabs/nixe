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

import type { ReviewBranch } from "../../core/file/backend";
import { ReviewService } from "../../core/git/review.service";
import { TabsService } from "../../core/tabs/tabs.service";
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

function render(list: ReviewBranch[] = branches) {
  const service = {
    branches: signal(list),
    count: signal(list.length),
    error: signal<string | null>(null),
    result: signal<string | null>(null),
    open: signal<ReviewBranch | null>(null),
    view: vi.fn(async () => undefined),
  };
  const tabs = { openView: vi.fn() };
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      { provide: ReviewService, useValue: service },
      { provide: TabsService, useValue: tabs },
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
  return { service, tabs, fixture, el: fixture.nativeElement as HTMLElement };
}

describe("ReviewComponent", () => {
  beforeAll(() => {
    TestBed.initTestEnvironment(BrowserTestingModule, platformBrowserTesting());
  });

  it("shows a suggestion as a card with who, when, number of notes and messages", () => {
    const { el } = render();
    expect(el.querySelector(".count")!.textContent).toContain("2");
    const cards = [...el.querySelectorAll(".card")];
    expect(cards[0].querySelector(".who")!.textContent).toBe("Claude");
    expect(cards[0].querySelector(".meta")!.textContent!.replace(/\s+/g, " ").trim()).toBe(
      "2023-11-14 22:13 · 2 notes",
    );
    expect(cards[1].querySelector(".meta")!.textContent).toContain("1 note");
    expect([...cards[0].querySelectorAll(".message")].map((l) => l.textContent)).toEqual([
      "tidy inbox",
      "fix links",
    ]);
  });

  it("names the branch only as tooltip", () => {
    const { el } = render();
    const cards = [...el.querySelectorAll<HTMLElement>(".card")];
    expect(cards[0].title).toBe("claude/a");
    expect(el.textContent).not.toContain("claude/a");
    expect(el.textContent).not.toContain("remote");
  });

  it("opens a suggestion in a review tab of the main area", () => {
    const { el, service, tabs } = render();
    el.querySelectorAll<HTMLElement>(".card")[1].click();
    expect(service.view).toHaveBeenCalledWith(branches[1]);
    expect(tabs.openView).toHaveBeenCalledWith("review");
  });

  it("says when nothing waits", () => {
    const { el } = render([]);
    expect(el.textContent).toContain("No suggestions to review");
  });
});

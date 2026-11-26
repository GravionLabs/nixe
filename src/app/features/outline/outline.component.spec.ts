// @vitest-environment jsdom
import "@angular/compiler";
import { signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { BrowserTestingModule, platformBrowserTesting } from "@angular/platform-browser/testing";
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

import { BookmarksService } from "../../core/bookmarks/bookmarks.service";
import { EditorService } from "../../core/editor/editor.service";
import { DocumentService } from "../../core/file/document.service";
import { OutlineService } from "../../core/outline/outline.service";
import { OutlineComponent } from "./outline.component";
import { pressArrow } from "../../../testing/list-keys";

function render(text: string, editing = false) {
  const content = signal(text);
  const pendingLine = signal<number | null>(null);
  const scrollToLine = vi.fn();
  const bookmarks = {
    relative: (p: string | null) => (p ? p.slice(3) : null),
    bookmarkHeading: vi.fn(),
  };
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      {
        provide: DocumentService,
        useValue: {
          content,
          pendingLine,
          path: signal("/v/n.md"),
          jump: (_t: unknown, scroll: () => boolean) => scroll(),
        },
      },
      { provide: BookmarksService, useValue: bookmarks },
      { provide: EditorService, useValue: { editing: signal(editing), handle: { scrollToLine } } },
    ],
  });
  TestBed.overrideComponent(OutlineComponent, { set: { styleUrl: undefined, styles: [] } });
  const fixture = TestBed.createComponent(OutlineComponent);
  fixture.detectChanges();
  const outline = TestBed.inject(OutlineService);
  return {
    fixture,
    el: fixture.nativeElement as HTMLElement,
    outline,
    pendingLine,
    scrollToLine,
    bookmarks,
  };
}

describe("OutlineComponent", () => {
  beforeAll(() => {
    TestBed.initTestEnvironment(BrowserTestingModule, platformBrowserTesting());
  });

  it("lists the headings as a tree with their levels", () => {
    const { el } = render("# A\n## B\n# C");
    const items = Array.from(el.querySelectorAll("li")).map((li) =>
      li.querySelector("button.heading")!.textContent!.trim(),
    );
    expect(items).toEqual(["A", "B", "C"]);
    expect(
      Array.from(el.querySelectorAll("li")).map((li) => li.getAttribute("aria-level")),
    ).toEqual(["1", "2", "1"]);
  });

  it("says so when there are no headings", () => {
    const { el } = render("text");
    expect(el.textContent).toContain("No headings");
    expect(el.querySelectorAll("button.heading").length).toBe(0);
  });

  it("scrolls the viewer to the heading on click", () => {
    const { el, pendingLine, scrollToLine } = render("# A\ntext\n## B");
    el.querySelectorAll("button.heading")[1]!.click();
    expect(pendingLine()).toBe(3);
    expect(scrollToLine).not.toHaveBeenCalled();
  });

  it("bookmarks a heading from its context menu", () => {
    const { el, bookmarks } = render("# A\ntext\n## B");
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    el.querySelectorAll("button.heading")[1]!.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(bookmarks.bookmarkHeading).toHaveBeenCalledWith("n.md", "B");
  });

  it("scrolls the editor to the heading on click while editing", () => {
    const { el, pendingLine, scrollToLine } = render("# A\ntext\n## B", true);
    el.querySelectorAll("button.heading")[1]!.click();
    expect(scrollToLine).toHaveBeenCalledWith(3);
    expect(pendingLine()).toBeNull();
  });

  it("highlights the current heading and updates while the text changes", () => {
    const { fixture, el, outline } = render("# A\ntext\n# B");
    outline.topLine.set(3);
    fixture.detectChanges();
    expect(el.querySelector("button.hx-list-row-current")!.textContent!.trim()).toBe("B");
    outline.editorText.set("# A\ntext\n# B\n# Typed");
    fixture.detectChanges();
    expect(el.querySelectorAll("button.heading").length).toBe(3);
    outline.topLine.set(1);
    fixture.detectChanges();
    expect(el.querySelector("button.hx-list-row-current")!.textContent!.trim()).toBe("A");
    expect(el.querySelectorAll("button.hx-list-row-current").length).toBe(1);
  });

  it("announces the current heading as the location", () => {
    const { fixture, el, outline } = render("# A\ntext\n# B");
    outline.topLine.set(3);
    fixture.detectChanges();
    const rows = el.querySelectorAll("button[hx-list-row]");
    expect([...rows].map((r) => r.getAttribute("aria-current"))).toEqual([null, "location"]);
  });

  it("moves through the headings with the arrows, in document order after folding", () => {
    const { fixture, el, outline } = render("# A\n## B\n# C");
    outline.collapseTo(1);
    fixture.detectChanges();
    outline.expandAll();
    fixture.detectChanges();
    const rows = el.querySelectorAll<HTMLButtonElement>("button[hx-list-row]");
    rows[0].focus();
    pressArrow(rows[0], "ArrowDown");
    expect(document.activeElement).toBe(rows[1]);
    pressArrow(rows[1], "ArrowDown");
    expect(document.activeElement).toBe(rows[2]);
  });

  describe("folding", () => {
    const text = "# A\n## B\n### C\n# D";
    const labels = (el: HTMLElement) =>
      Array.from(el.querySelectorAll("button.heading")).map((b) => b.textContent!.trim());

    it("collapses to H1, H2 or H3 and expands all", () => {
      const { fixture, el } = render(text);
      const level = (name: string) =>
        (Array.from(el.querySelectorAll("button.level")) as HTMLButtonElement[])
          .find((b) => b.textContent!.trim() === name)!
          .click();
      level("H1");
      fixture.detectChanges();
      expect(labels(el)).toEqual(["A", "D"]);
      level("H2");
      fixture.detectChanges();
      expect(labels(el)).toEqual(["A", "B", "D"]);
      level("H3");
      fixture.detectChanges();
      expect(labels(el)).toEqual(["A", "B", "C", "D"]);
      level("H1");
      level("All");
      fixture.detectChanges();
      expect(labels(el)).toEqual(["A", "B", "C", "D"]);
    });

    it("folds a single heading with children", () => {
      const { fixture, el } = render(text);
      expect(el.querySelectorAll("button.fold").length).toBe(2);
      (el.querySelector("button.fold") as HTMLButtonElement).click();
      fixture.detectChanges();
      expect(labels(el)).toEqual(["A", "D"]);
      expect(el.querySelector("li")!.getAttribute("aria-expanded")).toBe("false");
    });

    it("marks the parent while the current heading is folded away", () => {
      const { fixture, el, outline } = render(text);
      outline.topLine.set(3);
      fixture.detectChanges();
      expect(el.querySelector("button.hx-list-row-current")!.textContent!.trim()).toBe("C");
      outline.collapseTo(1);
      fixture.detectChanges();
      expect(el.querySelector("button.hx-list-row-current")!.textContent!.trim()).toBe("A");
      expect(el.querySelectorAll("button.hx-list-row-current").length).toBe(1);
      outline.expandAll();
      fixture.detectChanges();
      expect(el.querySelector("button.hx-list-row-current")!.textContent!.trim()).toBe("C");
    });
  });
});

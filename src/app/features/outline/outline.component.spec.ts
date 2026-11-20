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
      { provide: DocumentService, useValue: { content, pendingLine, path: signal("/v/n.md") } },
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

  it("lists the headings as a nested tree", () => {
    const { el } = render("# A\n## B\n# C");
    const items = Array.from(el.querySelectorAll("li")).map((li) =>
      li.querySelector("button")!.textContent!.trim(),
    );
    expect(items).toEqual(["A", "B", "C"]);
    expect(el.querySelector("li ul li button")!.textContent!.trim()).toBe("B");
  });

  it("says so when there are no headings", () => {
    const { el } = render("text");
    expect(el.textContent).toContain("No headings");
    expect(el.querySelectorAll("button").length).toBe(0);
  });

  it("scrolls the viewer to the heading on click", () => {
    const { el, pendingLine, scrollToLine } = render("# A\ntext\n## B");
    el.querySelectorAll("button")[1]!.click();
    expect(pendingLine()).toBe(3);
    expect(scrollToLine).not.toHaveBeenCalled();
  });

  it("bookmarks a heading from its context menu", () => {
    const { el, bookmarks } = render("# A\ntext\n## B");
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    el.querySelectorAll("button")[1]!.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(bookmarks.bookmarkHeading).toHaveBeenCalledWith("n.md", "B");
  });

  it("scrolls the editor to the heading on click while editing", () => {
    const { el, pendingLine, scrollToLine } = render("# A\ntext\n## B", true);
    el.querySelectorAll("button")[1]!.click();
    expect(scrollToLine).toHaveBeenCalledWith(3);
    expect(pendingLine()).toBeNull();
  });

  it("highlights the current heading and updates while the text changes", () => {
    const { fixture, el, outline } = render("# A\ntext\n# B");
    outline.topLine.set(3);
    fixture.detectChanges();
    expect(el.querySelector("button.current")!.textContent!.trim()).toBe("B");
    outline.editorText.set("# A\ntext\n# B\n# Typed");
    fixture.detectChanges();
    expect(el.querySelectorAll("button").length).toBe(3);
    outline.topLine.set(1);
    fixture.detectChanges();
    expect(el.querySelector("button.current")!.textContent!.trim()).toBe("A");
    expect(el.querySelectorAll("button.current").length).toBe(1);
  });
});

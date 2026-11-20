// @vitest-environment jsdom
import "@angular/compiler";
import { TestBed } from "@angular/core/testing";
import { BrowserTestingModule, platformBrowserTesting } from "@angular/platform-browser/testing";
import { beforeAll, describe, expect, it } from "vitest";

import { GRAB_WIDTH } from "../../core/panel/panel-width";
import { PanelResizerComponent } from "./panel-resizer.component";

function render(width = 300, windowWidth = 2000) {
  TestBed.resetTestingModule();
  const fixture = TestBed.createComponent(PanelResizerComponent);
  fixture.componentRef.setInput("width", width);
  fixture.componentRef.setInput("windowWidth", windowWidth);
  fixture.componentRef.setInput("sidebarWidth", 260);
  const emitted: number[] = [];
  fixture.componentInstance.widthChange.subscribe((w) => emitted.push(w));
  fixture.detectChanges();
  return { el: fixture.nativeElement as HTMLElement, emitted };
}

function pointer(type: string, clientX: number): Event {
  const e = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(e, { clientX, button: 0, pointerId: 1 });
  return e;
}

describe("PanelResizerComponent", () => {
  beforeAll(() => {
    TestBed.initTestEnvironment(BrowserTestingModule, platformBrowserTesting());
  });

  it("is a vertical separator with a grab area of at least 4px", () => {
    const { el } = render();
    expect(el.getAttribute("role")).toBe("separator");
    expect(el.getAttribute("aria-orientation")).toBe("vertical");
    expect(el.getAttribute("aria-valuenow")).toBe("300");
    expect(el.tabIndex).toBe(0);
    expect(GRAB_WIDTH).toBeGreaterThanOrEqual(4);
    expect(parseInt(el.style.width, 10)).toBeGreaterThanOrEqual(4);
  });

  it("widens the panel when dragged to the left", () => {
    const { el, emitted } = render();
    el.dispatchEvent(pointer("pointerdown", 500));
    el.dispatchEvent(pointer("pointermove", 450));
    el.dispatchEvent(pointer("pointermove", 520));
    el.dispatchEvent(pointer("pointerup", 520));
    el.dispatchEvent(pointer("pointermove", 100));
    expect(emitted).toEqual([350, 280]);
  });

  it("resizes with the arrow keys", () => {
    const { el, emitted } = render();
    const key = new KeyboardEvent("keydown", { key: "ArrowLeft", cancelable: true });
    el.dispatchEvent(key);
    el.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight" }));
    el.dispatchEvent(new KeyboardEvent("keydown", { key: "x" }));
    expect(key.defaultPrevented).toBe(true);
    expect(emitted).toEqual([316, 284]);
  });
});

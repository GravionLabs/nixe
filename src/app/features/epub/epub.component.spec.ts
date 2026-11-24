// @vitest-environment jsdom
import "@angular/compiler";
import { readFileSync } from "node:fs";
import { signal } from "@angular/core";
import type { ComponentFixture } from "@angular/core/testing";
import { TestBed } from "@angular/core/testing";
import { BrowserTestingModule, platformBrowserTesting } from "@angular/platform-browser/testing";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const view = vi.hoisted(() => ({
  open: vi.fn(),
  init: vi.fn(),
  goTo: vi.fn(),
  next: vi.fn(),
  prev: vi.fn(),
  close: vi.fn(),
  setAttribute: vi.fn(),
  setStyles: vi.fn(),
}));

// The real view renders in a browser (`e2e/epub.e2e.ts`); jsdom has no layout and loads no frames.
vi.mock("foliate-js/view.js", async () => {
  customElements.define(
    "foliate-view",
    class extends HTMLElement {
      renderer = { setAttribute: view.setAttribute, setStyles: view.setStyles };
      open = view.open;
      init = view.init;
      goTo = view.goTo;
      next = view.next;
      prev = view.prev;
      close = view.close;
    },
  );
  // The module registers its own element: that one is not wanted here, the book parser is.
  const define = customElements.define.bind(customElements);
  customElements.define = (name, ...rest) => {
    if (name !== "foliate-view") define(name, ...rest);
  };
  try {
    return await vi.importActual<ViewModule>("foliate-js/view.js");
  } finally {
    customElements.define = define;
  }
});
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

import type * as ViewModule from "foliate-js/view.js";
import type { EpubBook, EpubFlow } from "../../core/epub/epub";
import { bookCss } from "../../core/epub/epub";
import { EpubService } from "../../core/epub/epub.service";
import { SettingsService } from "../../core/settings/settings.service";
import { CURRENT_TAB } from "../../core/tabs/tabs.service";
import type { Tab } from "../../core/tabs/tabs.service";
import { EpubComponent } from "./epub.component";

async function sample(): Promise<EpubBook> {
  const { makeBook } = await import("foliate-js/view.js");
  const file = new File([readFileSync("fixtures/books/sample.epub")], "sample.epub");
  return { path: "/v/sample.epub", title: "Nixe Sample Book", book: await makeBook(file) };
}

async function settle(fixture: ComponentFixture<EpubComponent>): Promise<void> {
  for (let i = 0; i < 5; i++) {
    fixture.detectChanges();
    await fixture.whenStable();
    await new Promise((resolve) => setTimeout(resolve));
  }
}

describe("EpubComponent", () => {
  const position = vi.fn();
  const savePosition = vi.fn();
  const flushPosition = vi.fn();
  const flow = signal<EpubFlow>("paginated");
  const dark = signal(false);
  const zoom = signal(100);
  const setFlow = vi.fn((value: EpubFlow) => flow.set(value));

  beforeAll(() => {
    TestBed.initTestEnvironment(BrowserTestingModule, platformBrowserTesting());
  });

  beforeEach(() => {
    for (const fn of Object.values(view)) fn.mockReset().mockResolvedValue(undefined);
    view.setAttribute.mockReset();
    dark.set(false);
    zoom.set(100);
    flow.set("paginated");
    setFlow.mockClear();
    position.mockReset().mockResolvedValue(null);
    savePosition.mockReset();
    flushPosition.mockReset();
  });

  async function render(book: EpubBook | null) {
    const tab = { id: 3, epub: signal(book) } as unknown as Tab;
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        { provide: CURRENT_TAB, useValue: tab },
        { provide: SettingsService, useValue: { dark, zoom } },
        {
          provide: EpubService,
          useValue: { flow, setFlow, position, savePosition, flushPosition },
        },
      ],
    });
    TestBed.overrideComponent(EpubComponent, { set: { styleUrl: undefined } });
    const fixture = TestBed.createComponent(EpubComponent);
    await settle(fixture);
    // The view is created after the module of foliate-js has loaded.
    await (book === null
      ? Promise.resolve()
      : vi.waitFor(() => {
          if (view.open.mock.calls.length === 0) throw new Error("the book is not opened yet");
        }));
    await settle(fixture);
    return { fixture, el: fixture.nativeElement as HTMLElement };
  }

  it("opens the book in the view and shows the first text", async () => {
    const book = await sample();

    const { el } = await render(book);

    expect(el.querySelector("foliate-view")).not.toBeNull();
    expect(view.open).toHaveBeenCalledWith(book.book);
    expect(view.init).toHaveBeenCalledWith({ lastLocation: null, showTextStart: true });
    expect(view.setAttribute).toHaveBeenCalledWith("flow", "paginated");
    expect(el.querySelector("h1")?.textContent).toBe("Nixe Sample Book");
  });

  it("returns to the saved position", async () => {
    position.mockResolvedValue("epubcfi(/6/4!/4/2)");

    await render(await sample());

    expect(position).toHaveBeenCalledWith("/v/sample.epub");
    expect(view.init).toHaveBeenCalledWith({
      lastLocation: "epubcfi(/6/4!/4/2)",
      showTextStart: false,
    });
  });

  it("saves the position when the page changes, but not the one it restored", async () => {
    position.mockResolvedValue("epubcfi(/6/2)");
    const { el } = await render(await sample());
    const view = el.querySelector("foliate-view")!;

    view.dispatchEvent(new CustomEvent("relocate", { detail: { cfi: "epubcfi(/6/2)" } }));
    expect(savePosition).not.toHaveBeenCalled();
    view.dispatchEvent(new CustomEvent("relocate", { detail: { cfi: "epubcfi(/6/4)" } }));
    view.dispatchEvent(new CustomEvent("relocate", { detail: {} }));

    expect(savePosition).toHaveBeenCalledTimes(1);
    expect(savePosition).toHaveBeenCalledWith("/v/sample.epub", "epubcfi(/6/4)");
  });

  it("saves the restored page when the reader pages back to it", async () => {
    position.mockResolvedValue("epubcfi(/6/2)");
    const { el } = await render(await sample());
    const view = el.querySelector("foliate-view")!;

    for (const cfi of ["epubcfi(/6/2)", "epubcfi(/6/4)", "epubcfi(/6/2)"]) {
      view.dispatchEvent(new CustomEvent("relocate", { detail: { cfi } }));
    }

    expect(savePosition).toHaveBeenLastCalledWith("/v/sample.epub", "epubcfi(/6/2)");
  });

  it("styles the book with the theme and the zoom of the app", async () => {
    const { fixture } = await render(await sample());
    expect(view.setStyles).toHaveBeenLastCalledWith(bookCss(false, 100));

    dark.set(true);
    await settle(fixture);
    expect(view.setStyles).toHaveBeenLastCalledWith(bookCss(true, 100));

    zoom.set(150);
    await settle(fixture);
    expect(view.setStyles).toHaveBeenLastCalledWith(bookCss(true, 150));
  });

  it("stays on the position when the theme or the zoom changes", async () => {
    const { fixture, el } = await render(await sample());
    el.querySelector("foliate-view")!.dispatchEvent(
      new CustomEvent("relocate", { detail: { cfi: "epubcfi(/6/4)" } }),
    );
    view.goTo.mockClear();

    dark.set(true);
    await settle(fixture);
    zoom.set(120);
    await settle(fixture);

    expect(view.goTo).toHaveBeenCalledTimes(2);
    expect(view.goTo).toHaveBeenLastCalledWith("epubcfi(/6/4)");
  });

  it("writes the waiting position when the tab closes", async () => {
    const { fixture } = await render(await sample());

    fixture.destroy();

    expect(flushPosition).toHaveBeenCalledWith("/v/sample.epub");
  });

  it("lists the chapters and jumps to the one that is clicked", async () => {
    const { el } = await render(await sample());

    const entries = [...el.querySelectorAll<HTMLButtonElement>(".toc .entry")];
    expect(entries.map((e) => e.textContent?.trim())).toEqual(["Chapter 1", "Chapter 2"]);
    entries[1].click();

    expect(view.goTo).toHaveBeenCalledWith("OEBPS/chapter-2.xhtml");
  });

  it("marks the chapter of the position", async () => {
    const { fixture, el } = await render(await sample());

    el.querySelector("foliate-view")!.dispatchEvent(
      new CustomEvent("relocate", { detail: { tocItem: { href: "OEBPS/chapter-2.xhtml" } } }),
    );
    fixture.detectChanges();

    const entries = [...el.querySelectorAll<HTMLButtonElement>(".toc .entry")];
    expect(entries.map((e) => e.getAttribute("aria-current"))).toEqual([null, "location"]);
  });

  it("switches between paged and scrolled reading", async () => {
    const { fixture, el } = await render(await sample());

    el.querySelector<HTMLButtonElement>(".mode-scrolled")!.click();
    await settle(fixture);

    expect(setFlow).toHaveBeenCalledWith("scrolled");
    expect(view.setAttribute).toHaveBeenLastCalledWith("flow", "scrolled");
    expect(el.querySelector(".mode-scrolled")!.getAttribute("aria-pressed")).toBe("true");
    expect(el.querySelector(".mode-paginated")!.getAttribute("aria-pressed")).toBe("false");
  });

  it("turns the page with the keys and the buttons", async () => {
    const { el } = await render(await sample());
    const reader = el.querySelector<HTMLElement>(".reader")!;
    const press = (key: string, init: KeyboardEventInit = {}) =>
      reader.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, ...init }));

    press("PageDown");
    press("ArrowRight");
    press(" ");
    expect(view.next).toHaveBeenCalledTimes(3);
    press("PageUp");
    press("ArrowLeft");
    press(" ", { shiftKey: true });
    expect(view.prev).toHaveBeenCalledTimes(3);

    press("a");
    press("ArrowRight", { ctrlKey: true });
    expect(view.next).toHaveBeenCalledTimes(3);

    el.querySelector<HTMLButtonElement>(".next")!.click();
    el.querySelector<HTMLButtonElement>(".prev")!.click();
    expect(view.next).toHaveBeenCalledTimes(4);
    expect(view.prev).toHaveBeenCalledTimes(4);
  });

  it("leaves Space to a button that has the focus", async () => {
    const { el } = await render(await sample());
    const button = el.querySelector<HTMLButtonElement>(".next")!;

    button.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));

    expect(view.next).not.toHaveBeenCalled();
  });

  it("shows the reason when the book cannot be laid out", async () => {
    view.open.mockRejectedValue(new Error("bad spine"));

    const { el } = await render(await sample());

    expect(el.querySelector("[role=alert]")?.textContent).toContain("bad spine");
  });

  it("closes the view with the tab", async () => {
    const { fixture, el } = await render(await sample());

    fixture.destroy();

    expect(view.close).toHaveBeenCalled();
    expect(el.querySelector("foliate-view")).toBeNull();
  });

  it("shows an empty state without a book", async () => {
    const { el } = await render(null);

    expect(el.textContent).toContain("No book");
    expect(el.querySelector("foliate-view")).toBeNull();
  });
});

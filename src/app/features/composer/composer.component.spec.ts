// @vitest-environment jsdom
import "@angular/compiler";
import { computed, signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { BrowserTestingModule, platformBrowserTesting } from "@angular/platform-browser/testing";
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ ask: vi.fn() }));

import type { TargetOption } from "../../core/composer/composer.service";
import { ComposerService } from "../../core/composer/composer.service";
import { ComposerComponent } from "./composer.component";

const escape = (el: HTMLElement) =>
  el
    .querySelector("[role=dialog]")!
    .dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", keyCode: 27, bubbles: true }));
const footer = (el: HTMLElement) => [
  ...el.querySelectorAll<HTMLButtonElement>(".hx-dialog-footer button"),
];
const primary = (el: HTMLElement) =>
  footer(el).filter((b) => !b.matches(".hx-button-text, .hx-button-outlined, .hx-button-link"));

function render(paths: string[] = ["A.md", "B.md"]) {
  const options = signal<TargetOption[]>(paths.map((path) => ({ path, create: false })));
  const selected = signal(0);
  const composer = {
    title: signal("Merge into…"),
    query: signal(""),
    options,
    selected,
    current: computed(() => options()[selected()] ?? null),
    setQuery: vi.fn(),
    move: vi.fn((delta: number) => selected.update((i) => i + delta)),
    choose: vi.fn().mockResolvedValue(true),
    close: vi.fn(),
  };
  TestBed.resetTestingModule();
  document.body.replaceChildren();
  TestBed.configureTestingModule({ providers: [{ provide: ComposerService, useValue: composer }] });
  TestBed.overrideComponent(ComposerComponent, { set: { styleUrl: undefined } });
  const fixture = TestBed.createComponent(ComposerComponent);
  const failed = vi.fn();
  fixture.componentInstance.failed.subscribe(failed);
  fixture.detectChanges();
  // hx-dialog renders its content in the overlay, outside the host element.
  const el = document.body;
  const field = () => el.querySelector<HTMLInputElement>("input[role=combobox]")!;
  const key = (name: string) => {
    field().dispatchEvent(
      new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true }),
    );
    fixture.detectChanges();
  };
  return { composer, el, field, key, fixture, failed };
}

describe("ComposerComponent", () => {
  beforeAll(() => TestBed.initTestEnvironment(BrowserTestingModule, platformBrowserTesting()));

  it("labels the focused field with the title", async () => {
    // jsdom has no layout, so the focus trap would take every element for invisible.
    const rects = vi
      .spyOn(Element.prototype, "getClientRects")
      .mockReturnValue([{}] as unknown as DOMRectList);
    const { el, field } = render();
    const label = el.querySelector("label")!;
    expect(label.textContent?.trim()).toBe("Merge into…");
    expect(label.htmlFor).toBe(field().id);
    expect(field().classList).toContain("hx-input");
    await vi.waitFor(() => expect(document.activeElement).toBe(field()));
    rects.mockRestore();
  });

  it("takes the selected note with Enter", () => {
    const { composer, key } = render();
    key("ArrowDown");
    key("Enter");
    expect(composer.choose).toHaveBeenCalledOnce();
    expect(composer.choose).toHaveBeenCalledWith({ path: "B.md", create: false });
  });

  it("takes the selected note with the one primary button of the footer", () => {
    const { composer, el } = render();
    expect(footer(el).map((b) => b.textContent?.trim())).toEqual(["Cancel", "Choose"]);
    expect(footer(el)[0].classList).toContain("hx-button-text");
    expect(primary(el)).toEqual([footer(el)[1]]);
    primary(el)[0].click();
    expect(composer.choose).toHaveBeenCalledOnce();
    expect(composer.choose).toHaveBeenCalledWith({ path: "A.md", create: false });
  });

  it("disables the primary button without a note", () => {
    const { el } = render([]);
    expect(primary(el)[0].disabled).toBe(true);
    expect(el.textContent).toContain("No matching note");
  });

  it("takes a clicked note", () => {
    const { composer, el } = render();
    el.querySelectorAll<HTMLButtonElement>("li button")[1].click();
    expect(composer.choose).toHaveBeenCalledWith({ path: "B.md", create: false });
  });

  it("closes with Escape and with Cancel", async () => {
    for (const close of [escape, (el: HTMLElement) => footer(el)[0].click()]) {
      const { composer, el, fixture } = render();
      close(el);
      await vi.waitFor(() => {
        fixture.detectChanges();
        expect(composer.close).toHaveBeenCalled();
      });
      expect(composer.choose).not.toHaveBeenCalled();
    }
  });

  it("reports a failed choice", async () => {
    const { composer, key, failed } = render();
    composer.choose.mockRejectedValue("boom");
    key("Enter");
    await vi.waitFor(() => expect(failed).toHaveBeenCalledWith("boom"));
  });
});

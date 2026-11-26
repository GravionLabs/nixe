// @vitest-environment jsdom
import "@angular/compiler";
import { NO_ERRORS_SCHEMA, signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { BrowserTestingModule, platformBrowserTesting } from "@angular/platform-browser/testing";
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

import type { PaletteItem } from "../../core/commands/palette.service";
import { PaletteService } from "../../core/commands/palette.service";
import { ShortcutService } from "../../core/commands/shortcut.service";
import { KeyHintsComponent } from "./key-hints.component";
import { PaletteComponent } from "./palette.component";

const escape = (el: HTMLElement) =>
  el
    .querySelector("[role=dialog]")!
    .dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", keyCode: 27, bubbles: true }));

const vault: PaletteItem = { kind: "vault", path: "/home/u/notes" };

function render(items: PaletteItem[] = [vault], text = "") {
  const palette = {
    query: signal(text),
    text: signal(text),
    mode: signal(items.length ? "vaults" : "notes"),
    items: signal(items),
    selected: signal(0),
    notice: signal<string | null>(null),
    truncated: signal(false),
    current: () => items[0] ?? null,
    setQuery: vi.fn(),
    move: vi.fn(),
    run: vi.fn().mockResolvedValue(undefined),
    createNote: vi.fn().mockResolvedValue(undefined),
    close: vi.fn(),
  };
  TestBed.resetTestingModule();
  document.body.replaceChildren();
  TestBed.configureTestingModule({
    providers: [
      { provide: PaletteService, useValue: palette },
      { provide: ShortcutService, useValue: { keys: () => [] } },
    ],
  });
  TestBed.overrideComponent(PaletteComponent, { set: { styleUrl: undefined } });
  // The key hints have signal inputs, which JIT does not bind; they are not under test here.
  TestBed.overrideComponent(PaletteComponent, {
    remove: { imports: [KeyHintsComponent] },
    add: { schemas: [NO_ERRORS_SCHEMA] },
  });
  const fixture = TestBed.createComponent(PaletteComponent);
  fixture.detectChanges();
  // hx-dialog renders its content in the overlay, outside the host element.
  const el = document.body;
  const field = () => el.querySelector<HTMLInputElement>("input[role=combobox]")!;
  const enter = () =>
    field().dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
    );
  return { palette, el, field, enter, fixture };
}

describe("PaletteComponent", () => {
  beforeAll(() => TestBed.initTestEnvironment(BrowserTestingModule, platformBrowserTesting()));

  it("has the focused search field as a Helix input", async () => {
    // jsdom has no layout, so the focus trap would take every element for invisible.
    const rects = vi
      .spyOn(Element.prototype, "getClientRects")
      .mockReturnValue([{}] as unknown as DOMRectList);
    const { field } = render();
    expect(field().classList).toContain("hx-input");
    await vi.waitFor(() => expect(document.activeElement).toBe(field()));
    rects.mockRestore();
  });

  it("runs the selected item with Enter, its primary action", () => {
    const { palette, enter } = render();
    enter();
    expect(palette.run).toHaveBeenCalledWith(vault, false);
  });

  it("runs a clicked row, a Helix button", () => {
    const { palette, el } = render();
    const row = el.querySelector<HTMLButtonElement>("li button")!;
    expect(row.classList).toContain("hx-button-text");
    row.click();
    expect(palette.run).toHaveBeenCalledWith(vault, false);
  });

  it("creates the typed note when nothing matches", () => {
    const { palette, el, enter } = render([], "New");
    enter();
    el.querySelector<HTMLButtonElement>(".empty button")!.click();
    expect(palette.createNote).toHaveBeenCalledTimes(2);
  });

  it("closes with Escape", async () => {
    const { palette, el, fixture } = render();
    escape(el);
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(palette.close).toHaveBeenCalled();
    });
  });

  it("has no footer: the list keeps its own layout", () => {
    expect(render().el.querySelector(".hx-dialog-footer button")).toBeNull();
  });
});

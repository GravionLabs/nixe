// @vitest-environment jsdom
import "@angular/compiler";
import { readFileSync } from "node:fs";
import { signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { BrowserTestingModule, platformBrowserTesting } from "@angular/platform-browser/testing";
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

import type { RootChoice } from "../../core/workspace/workspaces.service";
import { WorkspacesService } from "../../core/workspace/workspaces.service";
import { RootChoiceComponent } from "./root-choice.component";

const escape = (el: HTMLElement) =>
  el
    .querySelector("[role=dialog]")!
    .dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", keyCode: 27, bubbles: true }));
const footer = (el: HTMLElement) => [
  ...el.querySelectorAll<HTMLButtonElement>(".hx-dialog-footer button"),
];
const primary = (el: HTMLElement) =>
  footer(el).filter((b) => !b.matches(".hx-button-text, .hx-button-outlined, .hx-button-link"));

function render(pending: RootChoice | null, chooseRootForm = vi.fn().mockResolvedValue(undefined)) {
  const workspaces = {
    rootChoice: signal(pending),
    chooseRootForm,
    cancelRootChoice: vi.fn(),
  };
  document.body.replaceChildren();
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [{ provide: WorkspacesService, useValue: workspaces }],
  });
  TestBed.overrideComponent(RootChoiceComponent, {
    set: {
      templateUrl: undefined,
      styleUrl: undefined,
      template: readFileSync("src/app/features/workspace/root-choice.component.html", "utf8"),
    },
  });
  const fixture = TestBed.createComponent(RootChoiceComponent);
  fixture.detectChanges();
  return {
    fixture,
    workspaces, // hx-dialog renders its content in the overlay, outside the host element.
    el: document.body,
  };
}

const pending: RootChoice = {
  path: "/home/u/Documents/Books",
  choices: [
    { name: "Documents", template: "$Documents/Books", resolved: "/home/u/Documents/Books" },
    { name: "Home", template: "$Home/Documents/Books", resolved: "/home/u/Documents/Books" },
  ],
};

describe("RootChoiceComponent", () => {
  beforeAll(() => {
    TestBed.initTestEnvironment(BrowserTestingModule, platformBrowserTesting());
  });

  const radios = (el: HTMLElement) => [
    ...el.querySelectorAll<HTMLInputElement>("input[type=radio]"),
  ];

  it("shows nothing without a pending choice", () => {
    expect(render(null).el.querySelector(".choice")).toBeNull();
  });

  it("lists the absolute path first and each variable form with its resolved path", () => {
    const { el } = render(pending);
    const rows = [...el.querySelectorAll(".choice label")].map((row) =>
      [...row.querySelectorAll("span")].map((s) => s.textContent?.trim()),
    );
    expect(rows).toEqual([
      ["Absolute path", "/home/u/Documents/Books"],
      ["$Documents/Books", "/home/u/Documents/Books"],
      ["$Home/Documents/Books", "/home/u/Documents/Books"],
    ]);
  });

  it("starts with the absolute path chosen and focused", async () => {
    // jsdom has no layout, so the focus trap would take every element for invisible.
    const rects = vi
      .spyOn(Element.prototype, "getClientRects")
      .mockReturnValue([{}] as unknown as DOMRectList);
    const { el } = render(pending);
    expect(radios(el).map((r) => r.checked)).toEqual([true, false, false]);
    await vi.waitFor(() => expect(document.activeElement).toBe(radios(el)[0]));
    rects.mockRestore();
  });

  it("adds the folder in the chosen form with the one primary button, which Enter presses", () => {
    const { el, workspaces, fixture } = render(pending);
    expect(footer(el).map((b) => b.textContent?.trim())).toEqual(["Cancel", "Add folder"]);
    expect(footer(el)[0].classList).toContain("hx-button-text");
    const [add] = primary(el);
    expect(primary(el)).toEqual([footer(el)[1]]);
    expect(add.type).toBe("submit");
    expect(add.form).toBe(radios(el)[0].form);
    add.click();
    expect(workspaces.chooseRootForm).toHaveBeenLastCalledWith(null);
    radios(el)[1].click();
    fixture.detectChanges();
    add.click();
    expect(workspaces.chooseRootForm).toHaveBeenLastCalledWith("$Documents/Books");
  });

  it("starts the next choice with the absolute path again", () => {
    const { el, workspaces, fixture } = render(pending);
    radios(el)[2].click();
    fixture.detectChanges();
    workspaces.rootChoice.set({ ...pending, path: "/home/u/Other" });
    fixture.detectChanges();
    primary(el)[0].click();
    expect(workspaces.chooseRootForm).toHaveBeenLastCalledWith(null);
  });

  it("cancels with Escape and with Cancel", async () => {
    for (const cancel of [escape, (el: HTMLElement) => footer(el)[0].click()]) {
      const { el, workspaces, fixture } = render(pending);
      cancel(el);
      await vi.waitFor(() => {
        fixture.detectChanges();
        expect(workspaces.cancelRootChoice).toHaveBeenCalled();
      });
      expect(workspaces.chooseRootForm).not.toHaveBeenCalled();
    }
  });

  it("reports a failure to add", async () => {
    const { fixture, el } = render(pending, vi.fn().mockRejectedValue("boom"));
    const failed = vi.fn();
    fixture.componentInstance.failed.subscribe(failed);
    primary(el)[0].click();
    await vi.waitFor(() => expect(failed).toHaveBeenCalledWith("boom"));
  });
});

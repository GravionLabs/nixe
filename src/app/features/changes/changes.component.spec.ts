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

import type { GitChange, VaultCommit } from "../../core/file/backend";
import { DocumentService } from "../../core/file/document.service";
import { ChangesService } from "../../core/git/changes.service";
import { WorkspaceService } from "../../core/workspace/workspace.service";
import { ChangesComponent } from "./changes.component";
import { pressArrow } from "../../../testing/list-keys";

const list: GitChange[] = [
  { path: "a.md", kind: "modified" },
  { path: "gone.md", kind: "deleted" },
];

function render(kind = "sync", openPath: string | null = null) {
  const open = vi.fn().mockResolvedValue(undefined);
  const service = {
    kind: signal(kind),
    changes: signal(list),
    message: signal<string | null>(null),
    loading: signal(false),
    showSync: vi.fn(),
    showYesterday: vi.fn(),
    showWeek: vi.fn(),
    chooseVersion: vi.fn(),
    showVersion: vi.fn(),
    chosen: signal<{ id: string; label: string } | null>(null),
    versions: signal<VaultCommit[]>([
      { id: "c2", author: "Ann", time: 1_700_000_000, message: "Second" },
      { id: "c1", author: "", time: 1_699_000_000, message: "" },
    ]),
    versionsError: signal<string | null>(null),
    compare: vi.fn(),
  };
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      { provide: ChangesService, useValue: service },
      { provide: DocumentService, useValue: { open, path: signal(openPath) } },
      { provide: WorkspaceService, useValue: { vaultRoot: signal("/vault") } },
    ],
  });
  TestBed.overrideComponent(ChangesComponent, {
    set: {
      templateUrl: undefined,
      styleUrl: undefined,
      template: readFileSync("src/app/features/changes/changes.component.html", "utf8"),
    },
  });
  const fixture = TestBed.createComponent(ChangesComponent);
  fixture.detectChanges();
  const tick = () => {
    TestBed.tick();
    fixture.detectChanges();
  };
  return { service, open, tick, el: fixture.nativeElement as HTMLElement };
}

const text = (el: Element) => el.textContent!.replace(/\s+/g, " ").trim();

/** The button that opens the `hx-select` of a picker. */
const trigger = (el: HTMLElement, picker: "range" | "version") =>
  el.querySelector<HTMLElement>(`hx-select.${picker} [role=combobox]`)!;

/** The control the visible label `name` points at. */
const labelOf = (el: HTMLElement, name: string) => {
  const label = [...el.querySelectorAll("label")].find((l) => text(l).startsWith(name))!;
  return el.querySelector(`#${label.htmlFor}`);
};

/** The options of the open dropdown; the overlay sits outside the component. */
const options = () => [...document.querySelectorAll<HTMLElement>("[role=option]")];

function choose(el: HTMLElement, picker: "range" | "version", label: string, tick: () => void) {
  trigger(el, picker).click();
  tick();
  options()
    .find((o) => text(o) === label)!
    .click();
  tick();
}

function press(target: Element, key: string, keyCode: number): void {
  target.dispatchEvent(
    new KeyboardEvent("keydown", { key, keyCode, bubbles: true, cancelable: true }),
  );
}

describe("ChangesComponent", () => {
  beforeAll(() => {
    TestBed.initTestEnvironment(BrowserTestingModule, platformBrowserTesting());
    // jsdom has no layout; the CDK listbox scrolls to the active option.
    Element.prototype.scrollIntoView = () => {};
  });

  it("lists changed, added and deleted notes", () => {
    const { el } = render();
    const names = [...el.querySelectorAll("app-note-row button[hx-list-row]")].map((b) =>
      b.textContent!.replace(/\s+/g, " ").trim(),
    );
    expect(names).toEqual(["●a", "−gone"]);
    const icons = [...el.querySelectorAll("app-status-icon [role=img]")].map((i) =>
      i.getAttribute("title"),
    );
    expect(icons).toEqual(["Changed", "Deleted"]);
    expect(el.querySelector("app-note-row button[hx-list-row]")!.getAttribute("title")).toBe(
      "a.md",
    );
    expect(el.querySelector(".diff")).toBeNull();
  });

  it("offers the ranges in a dropdown and no commit id field", () => {
    const { el, service, tick } = render();
    expect(labelOf(el, "Range")).toBe(trigger(el, "range"));
    expect(el.querySelector("input")).toBeNull();
    expect(el.querySelector(".version")).toBeNull();
    expect(trigger(el, "range").textContent).toContain("Last sync");
    trigger(el, "range").click();
    tick();
    expect(options().map(text)).toEqual([
      "Last sync",
      "Yesterday",
      "Last week",
      "Choose a version…",
    ]);
    trigger(el, "range").click();
    tick();
    for (const label of ["Yesterday", "Last week", "Choose a version…"]) {
      choose(el, "range", label, tick);
    }
    expect(service.showYesterday).toHaveBeenCalledTimes(1);
    expect(service.showWeek).toHaveBeenCalledTimes(1);
    expect(service.chooseVersion).toHaveBeenCalledTimes(1);
    expect(service.showSync).not.toHaveBeenCalled();
  });

  it("picks the last sync again from another range", () => {
    const { el, service, tick } = render("week");
    choose(el, "range", "Last sync", tick);
    expect(service.showSync).toHaveBeenCalledTimes(1);
  });

  it("opens the range dropdown and picks a range with the keyboard", () => {
    const { el, service, tick } = render();
    const range = trigger(el, "range");
    range.focus();
    press(range, "ArrowDown", 40);
    tick();
    // The open list has the focus; End goes to its last option.
    expect(document.activeElement!.getAttribute("role")).toBe("listbox");
    press(document.activeElement!, "End", 35);
    press(document.activeElement!, "Enter", 13);
    tick();
    expect(service.chooseVersion).toHaveBeenCalledTimes(1);
    expect(document.querySelector("[role=listbox]")).toBeNull();
  });

  it("lists the versions with date, message and author and picks one", () => {
    const { el, service, tick } = render("commit");
    expect(labelOf(el, "Version")).toBe(trigger(el, "version"));
    expect(trigger(el, "version").textContent).toContain("Pick a version");
    trigger(el, "version").click();
    tick();
    const labels = options().map(text);
    expect(labels).toHaveLength(2);
    expect(labels[0]).toContain("Second");
    expect(labels[0]).toContain("Ann");
    expect(labels[1]).toContain("(no message)");
    expect(document.querySelector(".hx-select-overlay input")).toBeNull();
    options()[0].click();
    tick();
    expect(service.showVersion).toHaveBeenCalledWith(service.versions()[0]);
  });

  it("shows the picked version and filters a list of ten or more", () => {
    const { el, service, tick } = render("commit");
    service.versions.set(
      Array.from({ length: 10 }, (_, i) => ({
        id: `v${i}`,
        author: "",
        time: 1_700_000_000,
        message: `Note ${i}`,
      })),
    );
    service.chosen.set({ id: "v3", label: "x" });
    tick();
    expect(trigger(el, "version").textContent).toContain("Note 3");
    trigger(el, "version").click();
    tick();
    expect(document.querySelector(".hx-select-overlay input")).not.toBeNull();
  });

  it("says why the versions could not be read", () => {
    const { el, service, tick } = render("commit");
    service.versionsError.set("no repository");
    tick();
    expect(el.querySelector(".status")!.textContent).toContain("no repository");
  });

  it("opens a note, but not a deleted one", () => {
    const { el, open, service } = render();
    const opens = el.querySelectorAll<HTMLElement>(".open");
    expect(opens).toHaveLength(1);
    expect(opens[0].getAttribute("aria-label")).toBe("Open a");
    opens[0].click();
    expect(open).toHaveBeenCalledWith("/vault/a.md");
    el.querySelectorAll<HTMLElement>("app-note-row button[hx-list-row]")[1].click();
    expect(service.compare).toHaveBeenCalledWith(list[1]);
  });

  it("marks the row of the open note as current and moves through the rows with the arrows", () => {
    const { el } = render("sync", "/vault/gone.md");
    const rows = el.querySelectorAll<HTMLButtonElement>("button[hx-list-row]");
    expect(rows[0].getAttribute("aria-current")).toBeNull();
    expect(rows[1].getAttribute("aria-current")).toBe("true");
    expect([...rows].map((r) => r.tabIndex)).toEqual([-1, 0]);
    rows[1].focus();
    pressArrow(rows[1], "ArrowUp");
    expect(document.activeElement).toBe(rows[0]);
  });
});

// @vitest-environment jsdom
import "@angular/compiler";
import { Component } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { BrowserTestingModule, platformBrowserTesting } from "@angular/platform-browser/testing";
import { HxList, HxListRow } from "@gravionlabs/helix-ui";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { pressArrow } from "../../../testing/list-keys";
import { EmptyStateComponent } from "./empty-state.component";
import { noteLabel } from "./note-label";
import { NoteRowComponent } from "./note-row.component";
import { NoteTitleComponent } from "./note-title.component";
import { PanelSectionComponent } from "./panel-section.component";
import { StatusIconComponent } from "./status-icon.component";

@Component({
  selector: "app-host",
  imports: [
    PanelSectionComponent,
    NoteRowComponent,
    NoteTitleComponent,
    HxList,
    HxListRow,
    EmptyStateComponent,
  ],
  template: `
    <app-panel-section title="Things" [count]="2" storageKey="things">
      <button panelActions type="button" class="act">Act</button>
      <hx-list aria-label="Notes">
        @for (path of paths; track path) {
          <app-note-row>
            <input rowStart type="checkbox" class="pick" />
            <button
              hx-list-row
              type="button"
              [current]="path === open"
              [title]="path"
              (click)="activated = activated + 1"
            >
              <app-note-title [path]="path" kind="renamed" />
              <span class="hx-list-row-meta">now</span>
            </button>
            <button rowActions type="button" class="more">More</button>
          </app-note-row>
        }
      </hx-list>
      <app-empty-state text="Nothing" action="Create" (activated)="created = created + 1" />
    </app-panel-section>
  `,
})
class HostComponent {
  readonly paths = ["notes/daily/today.md", "notes/other.md"];
  open = "notes/other.md";
  activated = 0;
  created = 0;
}

function render() {
  const fixture = TestBed.createComponent(HostComponent);
  fixture.detectChanges();
  return { fixture, el: fixture.nativeElement as HTMLElement };
}

describe("noteLabel", () => {
  it("splits the folder from the title and drops .md", () => {
    expect(noteLabel("a/b/Note.md")).toEqual({ title: "Note", folder: "a/b" });
    expect(noteLabel("Top.MD")).toEqual({ title: "Top", folder: "" });
    expect(noteLabel("a/readme.txt")).toEqual({ title: "readme.txt", folder: "a" });
  });
});

describe("shared panel blocks", () => {
  beforeAll(() => {
    TestBed.initTestEnvironment(BrowserTestingModule, platformBrowserTesting());
  });
  beforeEach(() => {
    localStorage.clear();
    TestBed.resetTestingModule();
  });

  it("shows title and count, and the actions in the head", () => {
    const { el } = render();
    expect(el.querySelector(".title")!.textContent).toBe("Things");
    expect(el.querySelector(".count")!.textContent).toBe("2");
    expect(el.querySelector(".head .act")).not.toBeNull();
  });

  it("collapses by keyboard-reachable button, announces aria-expanded, remembers the state", () => {
    const first = render();
    const toggle = first.el.querySelector<HTMLButtonElement>(".toggle")!;
    expect(toggle.tagName).toBe("BUTTON");
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    toggle.click();
    first.fixture.detectChanges();
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(first.el.querySelector("app-note-row")).toBeNull();
    expect(localStorage.getItem("nixe.panel-section.things")).toBe("0");

    TestBed.resetTestingModule();
    const second = render();
    expect(second.el.querySelector(".toggle")!.getAttribute("aria-expanded")).toBe("false");
    expect(second.el.querySelector("app-note-row")).toBeNull();
  });

  it("still works when the storage is unavailable", () => {
    const get = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    const set = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("denied");
    });
    const { fixture, el } = render();
    el.querySelector<HTMLButtonElement>(".toggle")!.click();
    fixture.detectChanges();
    expect(el.querySelector(".toggle")!.getAttribute("aria-expanded")).toBe("false");
    get.mockRestore();
    set.mockRestore();
  });

  it("renders a note row with dimmed folder, tooltip, status icon, meta and actions", () => {
    const { fixture, el } = render();
    const row = el.querySelector("app-note-row")!;
    const main = row.querySelector<HTMLButtonElement>("button[hx-list-row]")!;
    expect(main.title).toBe("notes/daily/today.md");
    expect(main.querySelector(".hx-list-row-label .title")!.textContent).toBe("today");
    expect(main.querySelector(".folder")!.textContent).toBe("notes/daily");
    expect(main.querySelector(".hx-list-row-meta")!.textContent).toBe("now");
    const icon = main.querySelector("[role=img]")!;
    expect(icon.getAttribute("title")).toBe("Renamed");
    expect(icon.getAttribute("aria-label")).toBe("Renamed");
    expect(row.querySelector(".actions .more")).not.toBeNull();
    expect(row.firstElementChild!.classList.contains("pick")).toBe(true);
    main.click();
    expect(fixture.componentInstance.activated).toBe(1);
  });

  it("marks the current row and moves through the rows with the arrows", () => {
    const { el } = render();
    const rows = el.querySelectorAll<HTMLButtonElement>("button[hx-list-row]");
    expect(rows[0].getAttribute("aria-current")).toBeNull();
    expect(rows[1].getAttribute("aria-current")).toBe("true");
    expect(rows[1].classList.contains("hx-list-row-current")).toBe(true);
    expect([...rows].map((r) => r.tabIndex)).toEqual([-1, 0]);
    rows[1].focus();
    pressArrow(rows[1], "ArrowUp");
    expect(document.activeElement).toBe(rows[0]);
    expect([...rows].map((r) => r.tabIndex)).toEqual([0, -1]);
  });

  it("names every kind of status", () => {
    const labels = (["added", "modified", "deleted", "renamed"] as const).map((kind) => {
      const f = TestBed.createComponent(StatusIconComponent);
      f.componentRef.instance.kind = kind;
      f.detectChanges();
      return f.nativeElement.querySelector("[role=img]").getAttribute("title");
    });
    expect(labels).toEqual(["New", "Changed", "Deleted", "Renamed"]);
  });

  it("shows an empty state with an action that fires", () => {
    const { fixture, el } = render();
    expect(el.querySelector("app-empty-state")!.textContent).toContain("Nothing");
    el.querySelector<HTMLButtonElement>("app-empty-state button")!.click();
    expect(fixture.componentInstance.created).toBe(1);
  });

  it("hides the action button without a label", () => {
    const f = TestBed.createComponent(EmptyStateComponent);
    f.componentRef.instance.text = "Empty";
    f.detectChanges();
    expect(f.nativeElement.querySelector("button")).toBeNull();
  });
});

// @vitest-environment jsdom
import "@angular/compiler";
import { Component } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { BrowserTestingModule, platformBrowserTesting } from "@angular/platform-browser/testing";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { EmptyStateComponent } from "./empty-state.component";
import { noteLabel } from "./note-label";
import { NoteRowComponent } from "./note-row.component";
import { PanelSectionComponent } from "./panel-section.component";
import { StatusIconComponent } from "./status-icon.component";

@Component({
  selector: "app-host",
  imports: [PanelSectionComponent, NoteRowComponent, EmptyStateComponent],
  template: `
    <app-panel-section title="Things" [count]="2" storageKey="things">
      <button panelActions type="button" class="act">Act</button>
      <app-note-row
        path="notes/daily/today.md"
        kind="renamed"
        [expanded]="false"
        (activated)="activated = activated + 1"
      >
        <button rowActions type="button" class="more">More</button>
      </app-note-row>
      <app-empty-state text="Nothing" action="Create" (activated)="created = created + 1" />
    </app-panel-section>
  `,
})
class HostComponent {
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

  it("renders a note row with dimmed folder, tooltip, status icon and actions", () => {
    const { fixture, el } = render();
    const main = el.querySelector<HTMLButtonElement>(".main")!;
    expect(main.title).toBe("notes/daily/today.md");
    expect(main.getAttribute("aria-expanded")).toBe("false");
    expect(el.querySelector(".row .title")!.textContent).toBe("today");
    expect(el.querySelector(".folder")!.textContent).toBe("notes/daily");
    const icon = el.querySelector("[role=img]")!;
    expect(icon.getAttribute("title")).toBe("Renamed");
    expect(icon.getAttribute("aria-label")).toBe("Renamed");
    expect(el.querySelector(".actions .more")).not.toBeNull();
    main.click();
    expect(fixture.componentInstance.activated).toBe(1);
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

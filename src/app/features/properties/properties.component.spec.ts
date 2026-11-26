// @vitest-environment jsdom
import "@angular/compiler";
import { signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { BrowserTestingModule, platformBrowserTesting } from "@angular/platform-browser/testing";
import { invoke } from "@tauri-apps/api/core";
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

import { SettingsService } from "../../core/settings/settings.service";
import { DocumentService } from "../../core/file/document.service";
import { PropertiesComponent } from "./properties.component";

const NOTE =
  "---\n# keep\ntitle: Hi\ncount: 2\ndone: false\nwhen: 2024-01-02\ntags:\n  - a\n---\nBody\n";

function render(text: string) {
  const content = signal(text);
  const write = vi.fn(async (_path: string, next: string) => content.set(next));
  const errors: string[] = [];
  vi.mocked(invoke).mockImplementation(async (cmd: string) =>
    cmd === "tags"
      ? [
          { tag: "idea", count: 2 },
          { tag: "a", count: 1 },
        ]
      : cmd === "notes"
        ? []
        : null,
  );
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      { provide: DocumentService, useValue: { path: signal("/v/n.md"), content, write } },
    ],
  });
  TestBed.overrideComponent(PropertiesComponent, { set: { styleUrl: undefined, styles: [] } });
  // The default is folded (#375); most tests work on the unfolded list.
  TestBed.inject(SettingsService).propertiesDisplay.set("visible");
  const fixture = TestBed.createComponent(PropertiesComponent);
  fixture.componentInstance.failed.subscribe((e) => errors.push(e));
  fixture.detectChanges();
  const el = fixture.nativeElement as HTMLElement;
  const settle = async () => {
    await fixture.whenStable();
    fixture.detectChanges();
  };
  const change = async (input: HTMLInputElement, value?: string) => {
    if (value !== undefined) input.value = value;
    input.dispatchEvent(new Event("change"));
    await settle();
  };
  return { el, write, content, errors, change, settle, fixture };
}

describe("PropertiesComponent", () => {
  beforeAll(() => {
    window.matchMedia = vi.fn().mockReturnValue({ matches: false, addEventListener: vi.fn() });
    TestBed.initTestEnvironment(BrowserTestingModule, platformBrowserTesting());
  });

  it("uses a control per type", () => {
    const { el } = render(NOTE);
    const row = (key: string) => el.querySelector<HTMLInputElement>(`input[aria-label="${key}"]`)!;
    expect(row("title").type).toBe("text");
    expect(row("count").type).toBe("number");
    expect(row("done").type).toBe("checkbox");
    expect(row("when").type).toBe("date");
    expect(el.querySelectorAll(".property-chip").length).toBe(1);
  });

  it("writes an edited text value and keeps the rest of the frontmatter", async () => {
    const { el, write, change } = render(NOTE);
    await change(el.querySelector<HTMLInputElement>('input[aria-label="title"]')!, "Bye");
    expect(write).toHaveBeenCalledWith("/v/n.md", NOTE.replace("title: Hi", "title: Bye"));
  });

  it("writes a checkbox and a number", async () => {
    const { el, content, change } = render(NOTE);
    const box = el.querySelector<HTMLInputElement>('input[aria-label="done"]')!;
    box.checked = true;
    await change(box);
    expect(content()).toBe(NOTE.replace("done: false", "done: true"));
    await change(el.querySelector<HTMLInputElement>('input[aria-label="count"]')!, "7");
    expect(content()).toContain("count: 7");
  });

  it("renames and removes a property", async () => {
    const { el, content, change, settle } = render(NOTE);
    await change(
      el.querySelector<HTMLInputElement>('input[aria-label="Name of property count"]')!,
      "total",
    );
    expect(content()).toBe(NOTE.replace("count: 2", "total: 2"));
    el.querySelector<HTMLButtonElement>('button[aria-label="Remove property done"]')!.click();
    await settle();
    expect(content()).not.toContain("done:");
  });

  it("adds a chip and removes a chip", async () => {
    const { el, content, change, settle } = render(NOTE);
    await change(el.querySelector<HTMLInputElement>(".chip-field")!, "#idea");
    expect(content()).toContain("  - a\n  - idea\n");
    el.querySelector<HTMLButtonElement>('button[aria-label="Remove a"]')!.click();
    await settle();
    expect(content()).not.toContain("  - a\n");
  });

  it("keeps numbers and their comments when another chip is removed", async () => {
    const text = "---\ntags:\n  - 2024 # year\n  - b\n---\n";
    const { el, content, settle } = render(text);
    el.querySelector<HTMLButtonElement>('button[aria-label="Remove b"]')!.click();
    await settle();
    expect(content()).toBe("---\ntags:\n  - 2024 # year\n---\n");
  });

  it("keeps numbers when a chip is added", async () => {
    const { el, content, change } = render("---\nk:\n  - 1\n  - 2\n---\n");
    await change(el.querySelector<HTMLInputElement>(".chip-field")!, "x");
    expect(content()).toBe("---\nk:\n  - 1\n  - 2\n  - x\n---\n");
  });

  it("removes the chip it shows, also after an empty item", async () => {
    const { el, content, settle } = render("---\nk:\n  -\n  - a\n  - b\n---\n");
    el.querySelector<HTMLButtonElement>('button[aria-label="Remove a"]')!.click();
    await settle();
    // The empty item stays (written as `null`, the list has no line-by-line form then).
    expect(content()).toBe("---\nk:\n  - null\n  - b\n---\n");
  });

  it("removes the last chip with Backspace in the empty field", async () => {
    const { el, content, settle } = render("---\nk:\n  - 1\n  - 2\n---\n");
    const field = el.querySelector<HTMLInputElement>(".chip-field")!;
    field.dispatchEvent(new KeyboardEvent("keydown", { key: "Backspace" }));
    await settle();
    expect(content()).toBe("---\nk:\n  - 1\n---\n");
  });

  it("shows a list with a mapping item read-only", () => {
    const text = "---\nk:\n  - {x: 1}\n  - b\n  - c\n---\n";
    const { el, write } = render(text);
    const chips = [...el.querySelectorAll(".property-chip")].map((c) => c.textContent?.trim());
    expect(chips).toEqual(['{"x":1}', "b", "c"]);
    expect(el.querySelectorAll(".property-chip button").length).toBe(0);
    expect(el.querySelector(".chip-field")).toBeNull();
    expect(write).not.toHaveBeenCalled();
  });

  it("offers the tags of the index", async () => {
    const { el, settle } = render(NOTE);
    el.querySelector<HTMLInputElement>(".chip-field")!.dispatchEvent(new Event("focus"));
    await settle();
    expect(
      [...el.querySelectorAll("datalist option")].map((o) => (o as HTMLOptionElement).value),
    ).toEqual(["idea"]);
  });

  it("gives a note without frontmatter one with the first property", async () => {
    const { el, content, settle, errors } = render("# Title\n");
    expect(el.querySelectorAll(".prop").length).toBe(0);
    el.querySelector<HTMLButtonElement>(".prop-add")!.click();
    await settle();
    const form = el.querySelector<HTMLFormElement>("form")!;
    form.querySelector<HTMLInputElement>("input")!.value = "tags";
    form.querySelector<HTMLSelectElement>("select")!.value = "tags";
    form.dispatchEvent(new Event("submit"));
    await settle();
    expect(errors).toEqual([]);
    expect(content()).toBe("---\ntags: []\n---\n# Title\n");
  });

  it("refuses a duplicate name and reports it", async () => {
    const { el, errors, settle, write } = render(NOTE);
    el.querySelector<HTMLButtonElement>(".prop-add")!.click();
    await settle();
    const form = el.querySelector<HTMLFormElement>("form")!;
    form.querySelector<HTMLInputElement>("input")!.value = "title";
    form.dispatchEvent(new Event("submit"));
    await settle();
    expect(errors[0]).toContain("already exists");
    expect(write).not.toHaveBeenCalled();
  });

  it("shows invalid frontmatter instead of the controls", () => {
    const { el } = render("---\na: [1\n---\n");
    expect(el.querySelector("[role=alert]")?.textContent).toContain("Invalid frontmatter");
    expect(el.querySelector(".prop-add")).toBeNull();
  });

  describe("folding", () => {
    const summary = (el: HTMLElement) => el.querySelector(".properties-summary");

    it("folds with the header and unfolds with the summary line", async () => {
      const { el, fixture, settle } = render(NOTE);
      const settings = TestBed.inject(SettingsService);
      settings.propertiesDisplay.set("visible");
      el.querySelector<HTMLButtonElement>(".properties-header")!.click();
      await settle();
      expect(settings.propertiesDisplay()).toBe("folded");
      expect(el.querySelector(".prop")).toBeNull();
      expect(summary(el)?.textContent).toContain("Properties · 5 · title: Hi · count: 2");
      expect(summary(el)?.getAttribute("aria-expanded")).toBe("false");
      el.querySelector<HTMLButtonElement>(".properties-summary")!.click();
      fixture.detectChanges();
      expect(settings.propertiesDisplay()).toBe("visible");
      expect(el.querySelector(".prop")).not.toBeNull();
    });

    it("shows nothing when hidden", () => {
      const { el, fixture } = render(NOTE);
      TestBed.inject(SettingsService).propertiesDisplay.set("hidden");
      fixture.detectChanges();
      expect(el.textContent!.trim()).toBe("");
    });

    it("shows no summary for a note without frontmatter", () => {
      const { el, fixture } = render("# Title\n");
      TestBed.inject(SettingsService).propertiesDisplay.set("folded");
      fixture.detectChanges();
      expect(summary(el)).toBeNull();
      expect(el.textContent!.trim()).toBe("");
    });

    it("keeps the warning of invalid frontmatter when folded", () => {
      const { el, fixture } = render("---\na: [1\n---\n");
      TestBed.inject(SettingsService).propertiesDisplay.set("folded");
      fixture.detectChanges();
      expect(el.querySelector("[role=alert]")?.textContent).toContain("Invalid frontmatter");
    });
  });

  describe("in the live preview (source input)", () => {
    const FM = "---\ntitle: Hi\ntags:\n  - a\n---";

    function inEditor(source: string) {
      const r = render("# unrelated\n");
      r.fixture.componentRef.setInput("sourceText", source);
      const edited: string[] = [];
      let editSource = 0;
      r.fixture.componentInstance.edited.subscribe((t) => edited.push(t));
      r.fixture.componentInstance.editSource.subscribe(() => editSource++);
      r.fixture.detectChanges();
      return { ...r, edited, editSource: () => editSource };
    }

    it("shows the given text and is smaller and muted through the in-editor class", () => {
      const { el, fixture } = inEditor(FM);
      TestBed.inject(SettingsService).propertiesDisplay.set("folded");
      fixture.detectChanges();
      expect(el.classList.contains("in-editor")).toBe(true);
      expect(el.querySelector(".summary-text")?.textContent).toContain("Properties · 2");
    });

    it("lists the properties unfolded", () => {
      const { el, fixture } = inEditor(FM);
      TestBed.inject(SettingsService).propertiesDisplay.set("visible");
      fixture.detectChanges();
      expect(el.querySelectorAll(".prop-key").length).toBe(2);
    });

    it("hands an edit to `edited` and does not write the note", async () => {
      const { el, fixture, edited, write, change } = inEditor(FM);
      TestBed.inject(SettingsService).propertiesDisplay.set("visible");
      fixture.detectChanges();
      const input = el.querySelector<HTMLInputElement>('input[aria-label="title"]')!;
      await change(input, "New");
      expect(edited).toHaveLength(1);
      expect(edited[0]).toContain("title: New");
      expect(write).not.toHaveBeenCalled();
    });

    it("offers Edit as source", () => {
      const { el, fixture, editSource } = inEditor(FM);
      TestBed.inject(SettingsService).propertiesDisplay.set("visible");
      fixture.detectChanges();
      const button = [...el.querySelectorAll("button")].find(
        (b) => b.textContent?.trim() === "Edit as source",
      )!;
      button.click();
      expect(editSource()).toBe(1);
    });

    it("shows the warning of invalid frontmatter", () => {
      const { el } = inEditor("---\na: [1\n---");
      expect(el.querySelector("[role=alert]")?.textContent).toContain("Invalid frontmatter");
    });

    it("has no Edit as source in the reading view", () => {
      const { el, fixture } = render(NOTE);
      TestBed.inject(SettingsService).propertiesDisplay.set("visible");
      fixture.detectChanges();
      expect(el.textContent).not.toContain("Edit as source");
    });
  });

  describe("in the sidebar panel", () => {
    function panel(text: string, display: "hidden" | "folded" | "visible" = "hidden") {
      const edits: string[] = [];
      TestBed.resetTestingModule();
      vi.mocked(invoke).mockImplementation(async () => []);
      TestBed.configureTestingModule({
        providers: [{ provide: DocumentService, useValue: { path: signal("/v/n.md") } }],
      });
      TestBed.overrideComponent(PropertiesComponent, { set: { styleUrl: undefined, styles: [] } });
      TestBed.inject(SettingsService).propertiesDisplay.set(display);
      const fixture = TestBed.createComponent(PropertiesComponent);
      fixture.componentRef.setInput("sidebarPanel", true);
      fixture.componentRef.setInput("sourceText", text);
      fixture.componentInstance.edited.subscribe((e) => edits.push(e));
      fixture.detectChanges();
      return { el: fixture.nativeElement as HTMLElement, edits, fixture };
    }

    it("is unfolded whatever the display setting says", () => {
      for (const display of ["hidden", "folded"] as const) {
        const { el } = panel(NOTE, display);
        expect(el.querySelector('input[aria-label="title"]')).not.toBeNull();
        expect(el.querySelector(".properties-header")).toBeNull();
        expect(el.textContent).not.toContain("Edit as source");
      }
    });

    it("hands an edit to its owner with the whole note text", () => {
      const { el, edits } = panel(NOTE);
      const input = el.querySelector<HTMLInputElement>('input[aria-label="title"]')!;
      input.value = "Bye";
      input.dispatchEvent(new Event("change"));
      expect(edits).toEqual([NOTE.replace("title: Hi", "title: Bye")]);
    });

    it("shows No properties and creates the frontmatter with Add property", async () => {
      const { el, edits, fixture } = panel("Body\n");
      expect(el.textContent).toContain("No properties");
      const add = [...el.querySelectorAll("button")].find(
        (b) => b.textContent?.trim() === "Add property",
      )!;
      add.click();
      fixture.detectChanges();
      const name = el.querySelector<HTMLInputElement>('input[aria-label="New property name"]')!;
      name.value = "status";
      el.querySelector("form")!.dispatchEvent(new Event("submit"));
      await fixture.whenStable();
      expect(edits).toEqual(['---\nstatus: ""\n---\nBody\n']);
    });

    it("reorders and removes properties", () => {
      const note = "---\na: x\nb: y\n---\n";
      const { el, edits } = panel(note);
      const click = (label: string) =>
        el.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!.click();
      expect(
        el.querySelector<HTMLButtonElement>('button[aria-label="Move property a up"]')!.disabled,
      ).toBe(true);
      click("Move property b up");
      click("Remove property a");
      expect(edits).toEqual(["---\nb: y\na: x\n---\n", "---\nb: y\n---\n"]);
    });

    it("shows the warning and no inputs for invalid frontmatter", () => {
      const { el } = panel("---\na: [1\n---\nBody\n");
      expect(el.querySelector(".frontmatter-warning")).not.toBeNull();
      expect(el.querySelector("input")).toBeNull();
    });
  });
});

// @vitest-environment jsdom
import "@angular/compiler";
import { signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { BrowserTestingModule, platformBrowserTesting } from "@angular/platform-browser/testing";
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => []) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

import { EditorService } from "../../core/editor/editor.service";
import { DocumentService } from "../../core/file/document.service";
import { OutlineService } from "../../core/outline/outline.service";
import { PropertiesComponent } from "./properties.component";
import { PropertiesPanelComponent } from "./properties-panel.component";

const NOTE = "---\ntitle: Hi\n---\nBody\n";

function render(opts: { editing: boolean; applyText?: (t: string) => void }) {
  const content = signal(NOTE);
  const write = vi.fn(async (_path: string, next: string) => content.set(next));
  const editorText = signal<string | null>(null);
  const editing = signal(opts.editing);
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      { provide: DocumentService, useValue: { path: signal("/v/n.md"), content, write } },
      { provide: OutlineService, useValue: { editorText } },
      {
        provide: EditorService,
        useValue: { editing, handle: opts.applyText ? { applyText: opts.applyText } : null },
      },
    ],
  });
  TestBed.overrideComponent(PropertiesComponent, { set: { styleUrl: undefined, styles: [] } });
  TestBed.overrideComponent(PropertiesPanelComponent, { set: { styleUrl: undefined, styles: [] } });
  const fixture = TestBed.createComponent(PropertiesPanelComponent);
  const errors: string[] = [];
  fixture.componentInstance.failed.subscribe((e) => errors.push(e));
  fixture.detectChanges();
  const el = fixture.nativeElement as HTMLElement;
  const title = () => el.querySelector<HTMLInputElement>('input[aria-label="title"]');
  const change = async (value: string) => {
    const input = title()!;
    input.value = value;
    input.dispatchEvent(new Event("change"));
    await fixture.whenStable();
    await new Promise((r) => setTimeout(r));
    fixture.detectChanges();
  };
  return { fixture, el, write, editorText, change, title, errors };
}

describe("PropertiesPanelComponent", () => {
  beforeAll(() => {
    window.matchMedia = vi.fn().mockReturnValue({ matches: false, addEventListener: vi.fn() });
    TestBed.initTestEnvironment(BrowserTestingModule, platformBrowserTesting());
  });

  it("writes a change into the file while the note is not edited", async () => {
    const { write, change, title } = render({ editing: false });
    await change("Bye");
    expect(write).toHaveBeenCalledWith("/v/n.md", NOTE.replace("Hi", "Bye"));
    expect(title()!.value).toBe("Bye");
  });

  it("hands a change to the editor, as one undoable edit, while the note is edited", async () => {
    const applyText = vi.fn();
    const { write, change } = render({ editing: true, applyText });
    await change("Bye");
    expect(applyText).toHaveBeenCalledWith(NOTE.replace("Hi", "Bye"));
    expect(write).not.toHaveBeenCalled();
  });

  it("follows the unsaved text of the editor", () => {
    const { fixture, editorText, title } = render({ editing: true, applyText: vi.fn() });
    expect(title()!.value).toBe("Hi");
    editorText.set("---\ntitle: Typed\n---\n");
    fixture.detectChanges();
    expect(title()!.value).toBe("Typed");
  });

  it("reports a failed write", async () => {
    const { write, change, errors } = render({ editing: false });
    write.mockRejectedValueOnce(new Error("disk full"));
    await change("Bye");
    expect(errors).toEqual(["disk full"]);
  });
});

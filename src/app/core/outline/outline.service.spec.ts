// @vitest-environment jsdom
import "@angular/compiler";
import { signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { BrowserTestingModule, platformBrowserTesting } from "@angular/platform-browser/testing";
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

import { DocumentService } from "../file/document.service";
import { OutlineService } from "./outline.service";

function setup(text: string) {
  const content = signal(text);
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [{ provide: DocumentService, useValue: { content } }],
  });
  return { outline: TestBed.inject(OutlineService), content };
}

describe("OutlineService", () => {
  beforeAll(() => {
    TestBed.initTestEnvironment(BrowserTestingModule, platformBrowserTesting());
  });

  it("follows the saved note, and the editor text while typing", () => {
    const { outline, content } = setup("# A");
    expect(outline.headings().map((h) => h.text)).toEqual(["A"]);
    outline.editorText.set("# A\n## Typed");
    expect(outline.headings().map((h) => h.text)).toEqual(["A", "Typed"]);
    outline.editorText.set(null);
    content.set("# Other");
    expect(outline.headings().map((h) => h.text)).toEqual(["Other"]);
  });

  it("highlights the heading at the top line while scrolling", () => {
    const { outline } = setup("# A\ntext\n# B\ntext");
    outline.topLine.set(2);
    expect(outline.current()).toBe(0);
    outline.topLine.set(4);
    expect(outline.current()).toBe(1);
  });
});

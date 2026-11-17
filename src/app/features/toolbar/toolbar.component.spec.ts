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

import { CommandRegistry } from "../../core/commands/command-registry";
import { EditorService } from "../../core/editor/editor.service";
import { DocumentService } from "../../core/file/document.service";
import { SettingsService } from "../../core/settings/settings.service";
import { UpdateService } from "../../core/updater/update.service";
import { WorkspaceService } from "../../core/workspace/workspace.service";
import { ToolbarComponent } from "./toolbar.component";

function render(opts: { path: string | null; editing: boolean; blocked?: boolean }) {
  const execute = vi.fn().mockReturnValue(true);
  const check = vi.fn();
  const editing = signal(opts.editing);
  const blocked = signal(opts.blocked ?? false);
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      { provide: CommandRegistry, useValue: { execute } },
      { provide: EditorService, useValue: { editing, blocked } },
      {
        provide: DocumentService,
        useValue: { path: signal(opts.path), fileName: signal(""), canGoBack: signal(false), canGoForward: signal(false) },
      },
      { provide: WorkspaceService, useValue: { root: signal(null) } },
      { provide: UpdateService, useValue: { version: signal("1.2.3"), busy: signal(false), check } },
      {
        provide: SettingsService,
        useValue: { zoom: signal(100), math: signal(true), sidebarVisible: signal(true), themeMode: signal("system") },
      },
    ],
  });
  TestBed.overrideComponent(ToolbarComponent, {
    set: {
      templateUrl: undefined,
      styleUrl: undefined,
      template: readFileSync("src/app/features/toolbar/toolbar.component.html", "utf8"),
    },
  });
  const fixture = TestBed.createComponent(ToolbarComponent);
  fixture.detectChanges();
  const el = fixture.nativeElement as HTMLElement;
  const button = [...el.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Edit")!;
  return { fixture, button, execute, editing, blocked, check, el };
}

describe("ToolbarComponent edit toggle", () => {
  beforeAll(() => {
    TestBed.initTestEnvironment(BrowserTestingModule, platformBrowserTesting());
  });

  it("follows editing() and runs toggle-editor on click", () => {
    const { fixture, button, execute, editing } = render({ path: "/n.md", editing: false });
    expect(button.getAttribute("aria-pressed")).toBe("false");
    expect(button.classList.contains("active")).toBe(false);
    expect(button.title).toMatch(/^Toggle editor \((⌘|Ctrl\+)E\)$/);
    button.click();
    expect(execute).toHaveBeenCalledWith("toggle-editor");
    editing.set(true);
    fixture.detectChanges();
    expect(button.getAttribute("aria-pressed")).toBe("true");
    expect(button.classList.contains("active")).toBe(true);
  });

  it("is disabled without a note and while an external change blocks closing", () => {
    expect(render({ path: null, editing: false }).button.disabled).toBe(true);
    expect(render({ path: "/n.md", editing: true, blocked: true }).button.disabled).toBe(true);
    expect(render({ path: "/n.md", editing: true }).button.disabled).toBe(false);
  });
});

describe("ToolbarComponent version control", () => {
  it("shows the running version and checks for updates on click", () => {
    const { el, check } = render({ path: null, editing: false });
    const version = [...el.querySelectorAll("button")].find((b) => b.textContent?.trim() === "v1.2.3")!;
    version.click();
    expect(check).toHaveBeenCalled();
  });
});

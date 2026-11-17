// @vitest-environment jsdom
import "@angular/compiler";
import { signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { BrowserTestingModule, platformBrowserTesting } from "@angular/platform-browser/testing";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { EditorHandle, EditorService } from "../editor/editor.service";
import { backend } from "../file/backend";
import { DocumentService } from "../file/document.service";
import { SettingsService } from "../settings/settings.service";
import { WorkspaceService } from "../workspace/workspace.service";
import { TemplateService } from "./template.service";

describe("TemplateService", () => {
  const vaultFiles = signal<string[] | null>([]);
  const templateFolderSetting = signal("");
  let templates: TemplateService;
  let editor: { handle: EditorHandle | null };
  let inserted: string[];

  beforeAll(() => {
    TestBed.initTestEnvironment(BrowserTestingModule, platformBrowserTesting());
  });

  beforeEach(() => {
    inserted = [];
    editor = {
      handle: { topLine: () => 1, flush: async () => {}, blocked: () => false, insertTemplate: (t) => void inserted.push(t) },
    };
    vaultFiles.set(["Templates/Daily.md", "Templates/Meeting.md", "Templates/sub/Deep.md", "Templates/logo.png", "Other/Daily.md", "Note.md"]);
    templateFolderSetting.set("");
    vi.restoreAllMocks();
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        { provide: WorkspaceService, useValue: { vaultRoot: signal("/v"), vaultFiles } },
        { provide: DocumentService, useValue: { path: signal("/v/Journal/Trip plan.md") } },
        { provide: EditorService, useValue: editor },
        { provide: SettingsService, useValue: { templateFolder: templateFolderSetting } },
      ],
    });
    templates = TestBed.inject(TemplateService);
  });

  it("takes the folder from .obsidian/templates.json before the setting", async () => {
    vi.spyOn(backend, "templateFolder").mockResolvedValue("Templates");
    templateFolderSetting.set("Other");
    expect(await templates.folder()).toBe("Templates");
  });

  it("falls back to the setting, trimming slashes", async () => {
    vi.spyOn(backend, "templateFolder").mockResolvedValue(null);
    templateFolderSetting.set("/Other/");
    expect(await templates.folder()).toBe("Other");
  });

  it("has no folder when neither names one", async () => {
    vi.spyOn(backend, "templateFolder").mockRejectedValue("x");
    expect(await templates.folder()).toBeNull();
    await expect(templates.open()).rejects.toThrow(/No template folder/);
  });

  it("lists the Markdown files of the folder, below it too", async () => {
    vi.spyOn(backend, "templateFolder").mockResolvedValue("Templates");
    await templates.open();
    expect(templates.matches().map((e) => e.path)).toEqual(["Templates/Daily.md", "Templates/sub/Deep.md", "Templates/Meeting.md"]);
    templates.setQuery("meet");
    expect(templates.matches().map((e) => e.name)).toEqual(["Meeting"]);
  });

  it("says so when the folder has no template", async () => {
    vi.spyOn(backend, "templateFolder").mockResolvedValue("Empty");
    await expect(templates.open()).rejects.toThrow(/No templates in Empty/);
  });

  it("needs the editor", async () => {
    vi.spyOn(backend, "templateFolder").mockResolvedValue("Templates");
    editor.handle = null;
    await expect(templates.open()).rejects.toThrow(/Open the editor/);
  });

  it("inserts the chosen template with the variables replaced", async () => {
    vi.spyOn(backend, "templateFolder").mockResolvedValue("Templates");
    const read = vi.spyOn(backend, "readTextFile").mockResolvedValue("# {{title}} {{date:YYYY}}");
    await templates.open();
    await templates.insert(templates.matches().find((e) => e.name === "Daily")!);
    expect(read).toHaveBeenCalledWith("/v/Templates/Daily.md");
    expect(inserted).toEqual([`# Trip plan ${new Date().getFullYear()}`]);
    expect(templates.visible()).toBe(false);
  });

  it("moves the selection with wrap-around", async () => {
    vi.spyOn(backend, "templateFolder").mockResolvedValue("Templates");
    await templates.open();
    templates.move(-1);
    expect(templates.current()?.name).toBe("Meeting");
    templates.move(1);
    expect(templates.current()?.name).toBe("Daily");
  });
});

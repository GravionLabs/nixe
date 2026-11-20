// @vitest-environment jsdom
import "@angular/compiler";
import { signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { BrowserTestingModule, platformBrowserTesting } from "@angular/platform-browser/testing";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { EditorService } from "../editor/editor.service";
import { backend } from "../file/backend";
import { DocumentService } from "../file/document.service";
import { SettingsService } from "../settings/settings.service";
import { WorkspaceService } from "../workspace/workspace.service";
import { DailyService } from "./daily.service";

describe("DailyService", () => {
  const vaultFiles = signal<string[] | null>([]);
  const docPath = signal<string | null>(null);
  const setting = { dailyFolder: signal(""), dailyFormat: signal(""), dailyTemplate: signal("") };
  const open = vi.fn();
  const reloadTree = vi.fn();
  const now = new Date(2026, 2, 2, 9, 30);
  let daily: DailyService;

  beforeAll(() => {
    TestBed.initTestEnvironment(BrowserTestingModule, platformBrowserTesting());
  });

  beforeEach(() => {
    vi.restoreAllMocks();
    open.mockReset();
    reloadTree.mockReset();
    vaultFiles.set([]);
    docPath.set(null);
    setting.dailyFolder.set("");
    setting.dailyFormat.set("");
    setting.dailyTemplate.set("");
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        {
          provide: WorkspaceService,
          useValue: { vaultRoot: signal("/v"), vaultFiles, reloadTree },
        },
        { provide: DocumentService, useValue: { path: docPath, open } },
        { provide: EditorService, useValue: { handle: null } },
        { provide: SettingsService, useValue: setting },
      ],
    });
    daily = TestBed.inject(DailyService);
    vi.spyOn(backend, "dailyNotesConfig").mockResolvedValue({
      folder: null,
      format: null,
      template: null,
    });
  });

  it("takes each key from daily-notes.json, else from the settings", async () => {
    setting.dailyFolder.set("Settings folder");
    setting.dailyFormat.set("YYYY");
    setting.dailyTemplate.set("T/Settings");
    vi.spyOn(backend, "dailyNotesConfig").mockResolvedValue({
      folder: "Journal",
      format: null,
      template: "T/Vault",
    });
    expect(await daily.config()).toEqual({
      folder: "Journal",
      format: "YYYY",
      template: "T/Vault",
    });
  });

  it("uses the settings when the vault has no daily-notes.json", async () => {
    vi.spyOn(backend, "dailyNotesConfig").mockRejectedValue("x");
    setting.dailyFolder.set("/Days/");
    expect(await daily.config()).toEqual({ folder: "Days", format: "", template: "" });
  });

  it("opens today's note when it exists", async () => {
    vi.spyOn(backend, "isFile").mockResolvedValue(true);
    const create = vi.spyOn(backend, "createFile");
    await daily.openToday(now);
    expect(create).not.toHaveBeenCalled();
    expect(open).toHaveBeenCalledWith("/v/2026-03-02.md");
  });

  it("creates a missing note from the template in a nested folder", async () => {
    vi.spyOn(backend, "dailyNotesConfig").mockResolvedValue({
      folder: "Journal",
      format: "YYYY/MM/YYYY-MM-DD",
      template: "Templates/Daily",
    });
    vi.spyOn(backend, "isFile").mockResolvedValue(false);
    const read = vi
      .spyOn(backend, "readTextFile")
      .mockResolvedValue("# {{title}}\n{{date:dddd}}\n");
    const dir = vi.spyOn(backend, "createDir").mockResolvedValue();
    const file = vi.spyOn(backend, "createFile").mockResolvedValue();
    const write = vi.spyOn(backend, "writeTextFile").mockResolvedValue();
    await daily.openToday(now);
    expect(read).toHaveBeenCalledWith("/v/Templates/Daily.md");
    expect(dir).toHaveBeenCalledWith("/v/Journal/2026/03");
    expect(file).toHaveBeenCalledWith("/v/Journal/2026/03/2026-03-02.md");
    expect(write).toHaveBeenCalledWith(
      "/v/Journal/2026/03/2026-03-02.md",
      "# 2026-03-02\nMonday\n",
    );
    expect(reloadTree).toHaveBeenCalled();
    expect(open).toHaveBeenCalledWith("/v/Journal/2026/03/2026-03-02.md");
  });

  it("creates an empty note without a template and fails on a missing template", async () => {
    vi.spyOn(backend, "isFile").mockResolvedValue(false);
    vi.spyOn(backend, "createDir").mockResolvedValue();
    vi.spyOn(backend, "createFile").mockResolvedValue();
    const write = vi.spyOn(backend, "writeTextFile").mockResolvedValue();
    await daily.openToday(now);
    expect(write).not.toHaveBeenCalled();

    setting.dailyTemplate.set("Nope");
    vi.spyOn(backend, "readTextFile").mockRejectedValue("missing");
    await expect(daily.openToday(now)).rejects.toThrow(/template not found: Nope\.md/);
  });

  it("goes to the previous and the next daily note of the open one", async () => {
    vaultFiles.set(["2026-02-27.md", "2026-03-02.md", "2026-03-05.md", "Note.md"]);
    docPath.set("/v/2026-03-02.md");
    await daily.previous(now);
    expect(open).toHaveBeenLastCalledWith("/v/2026-02-27.md");
    await daily.next(now);
    expect(open).toHaveBeenLastCalledWith("/v/2026-03-05.md");
  });

  it("starts from today when the open note is no daily note, and says when there is none", async () => {
    vaultFiles.set(["2026-02-27.md", "2026-03-02.md"]);
    docPath.set("/v/Note.md");
    await daily.previous(now);
    expect(open).toHaveBeenLastCalledWith("/v/2026-02-27.md");
    await expect(daily.next(now)).rejects.toThrow(/No next daily note/);
  });
});

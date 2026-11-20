// @vitest-environment jsdom
import "@angular/compiler";
import { TestBed } from "@angular/core/testing";
import { BrowserTestingModule, platformBrowserTesting } from "@angular/platform-browser/testing";
import { ask } from "@tauri-apps/plugin-dialog";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ ask: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";

import { EditorService } from "../editor/editor.service";
import { NoteReplacements } from "../file/backend";
import { DocumentService } from "../file/document.service";
import { SettingsService } from "../settings/settings.service";
import { WorkspaceService } from "../workspace/workspace.service";
import { ReplaceService, describeReplace } from "./replace.service";

const preview: NoteReplacements[] = [
  {
    path: "a.md",
    count: 2,
    replacements: [
      { index: 0, line: 1, before: "foo", after: "bar" },
      { index: 1, line: 2, before: "foo", after: "bar" },
    ],
  },
  { path: "b.md", count: 1, replacements: [{ index: 0, line: 1, before: "foo", after: "bar" }] },
];

describe("ReplaceService", () => {
  let service: ReplaceService;
  const reloadTree = vi.fn();
  const reload = vi.fn();

  beforeAll(() => {
    TestBed.initTestEnvironment(BrowserTestingModule, platformBrowserTesting());
  });

  beforeEach(() => {
    vi.mocked(invoke).mockReset();
    vi.mocked(ask).mockReset().mockResolvedValue(true);
    reloadTree.mockReset().mockResolvedValue(undefined);
    reload.mockReset().mockResolvedValue(undefined);
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        { provide: WorkspaceService, useValue: { reloadTree } },
        { provide: DocumentService, useValue: { path: () => "/v/a.md", reload } },
        { provide: EditorService, useValue: { handle: null } },
        {
          provide: SettingsService,
          useValue: { gitAuthorName: () => " N ", gitAuthorEmail: () => "" },
        },
      ],
    });
    service = TestBed.inject(ReplaceService);
    service.enabled.set(true);
  });

  it("names the number of notes in the confirmation", () => {
    expect(describeReplace(1, 1)).toContain("1 replacement in 1 note?");
    expect(describeReplace(3, 7)).toContain("7 replacements in 3 notes?");
  });

  it("reads the preview with the options", async () => {
    vi.mocked(invoke).mockResolvedValue(preview);
    service.replacement.set("bar");
    service.regex.set(true);
    await service.refresh("foo");
    expect(invoke).toHaveBeenCalledWith("replace_preview", {
      options: { find: "foo", replace: "bar", regex: true, caseSensitive: false, wholeWord: false },
    });
    expect(service.totals()).toEqual({ notes: 2, replacements: 3 });
  });

  it("does nothing without the replace field or a find text", async () => {
    await service.refresh("");
    service.enabled.set(false);
    await service.refresh("foo");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("shows an invalid pattern as an error", async () => {
    vi.mocked(invoke).mockRejectedValue("invalid pattern: x");
    await service.refresh("(");
    expect(service.error()).toBe("invalid pattern: x");
    expect(service.notes()).toEqual([]);
  });

  it("counts without excluded notes and matches", async () => {
    vi.mocked(invoke).mockResolvedValue(preview);
    await service.refresh("foo");
    service.toggleMatch("a.md", 1);
    expect(service.totals()).toEqual({ notes: 2, replacements: 2 });
    service.toggleNote("b.md");
    expect(service.totals()).toEqual({ notes: 1, replacements: 1 });
    service.toggleMatch("a.md", 0);
    expect(service.totals()).toEqual({ notes: 0, replacements: 0 });
    service.toggleNote("b.md");
    expect(service.isNoteExcluded("b.md")).toBe(false);
  });

  it("applies in one batch after the confirmation and sends the exclusions", async () => {
    vi.mocked(invoke).mockResolvedValueOnce(preview);
    await service.refresh("foo");
    service.toggleNote("b.md");
    service.toggleMatch("a.md", 1);
    vi.mocked(invoke)
      .mockResolvedValueOnce({ notes: 1, replacements: 1, paths: ["a.md"] })
      .mockResolvedValueOnce([]);
    const done = await service.apply("foo");
    expect(done?.notes).toBe(1);
    expect(vi.mocked(ask).mock.calls[0][0]).toContain("1 replacement in 1 note?");
    expect(invoke).toHaveBeenCalledWith("replace_apply", {
      options: expect.objectContaining({ find: "foo" }),
      exclusions: { notes: ["b.md"], matches: [["a.md", 1]] },
      name: "N",
      email: null,
    });
    expect(reloadTree).toHaveBeenCalled();
    expect(reload).toHaveBeenCalled();
  });

  it("changes nothing when the user declines", async () => {
    vi.mocked(invoke).mockResolvedValueOnce(preview);
    await service.refresh("foo");
    vi.mocked(ask).mockResolvedValue(false);
    expect(await service.apply("foo")).toBeNull();
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("does not ask when every match is excluded", async () => {
    vi.mocked(invoke).mockResolvedValueOnce(preview);
    await service.refresh("foo");
    service.toggleNote("a.md");
    service.toggleNote("b.md");
    expect(await service.apply("foo")).toBeNull();
    expect(ask).not.toHaveBeenCalled();
  });
});

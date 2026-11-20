// @vitest-environment jsdom
import "@angular/compiler";
import { signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { BrowserTestingModule, platformBrowserTesting } from "@angular/platform-browser/testing";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ ask: vi.fn() }));

import { ask } from "@tauri-apps/plugin-dialog";

import { EditorService } from "../editor/editor.service";
import { backend } from "../file/backend";
import { DocumentService } from "../file/document.service";
import { SettingsService } from "../settings/settings.service";
import { WorkspaceService } from "../workspace/workspace.service";
import { ComposerService } from "./composer.service";

describe("ComposerService", () => {
  const path = signal<string | null>("/v/A.md");
  const doc = { path, open: vi.fn(), reload: vi.fn() };
  const workspace = {
    vaultRoot: signal("/v"),
    vaultFiles: signal<readonly string[] | null>(["A.md", "B.md", "Sub/Cee.md", "img.png"]),
    reloadTree: vi.fn(),
  };
  const flush = vi.fn();
  const editor = {
    editing: signal(true),
    handle: {
      flush,
      selection: () => ({ start: 2, end: 5, text: "abc" }),
      headingLine: () => 3,
    } as unknown,
  };
  const settings = { extractEmbed: signal(false) };
  let composer: ComposerService;

  beforeAll(() => {
    TestBed.initTestEnvironment(BrowserTestingModule, platformBrowserTesting());
  });

  beforeEach(() => {
    vi.restoreAllMocks();
    flush.mockReset().mockResolvedValue(undefined);
    doc.open = vi.fn().mockResolvedValue(undefined);
    doc.reload = vi.fn().mockResolvedValue(undefined);
    workspace.reloadTree = vi.fn().mockResolvedValue(undefined);
    settings.extractEmbed.set(false);
    editor.editing.set(true);
    vi.mocked(ask).mockReset().mockResolvedValue(true);
    vi.spyOn(backend, "readTextFile").mockResolvedValue("x\ny\n## Idea\nbody\n");
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        { provide: WorkspaceService, useValue: workspace },
        { provide: DocumentService, useValue: doc },
        { provide: EditorService, useValue: editor },
        { provide: SettingsService, useValue: settings },
      ],
    });
    composer = TestBed.inject(ComposerService);
  });

  it("asks for the selection first", async () => {
    editor.handle = { flush, selection: () => null };
    await expect(composer.extractSelection()).rejects.toThrow("Select");
    editor.handle = { flush, selection: () => ({ start: 2, end: 5, text: "abc" }), headingLine: () => 3 };
  });

  it("lists the other notes and offers a new one when extracting", async () => {
    await composer.extractSelection();
    expect(composer.visible()).toBe(true);
    expect(composer.options().map((o) => o.path)).toEqual(["B.md", "Sub/Cee.md"]);
    composer.setQuery("Fresh");
    expect(composer.options()).toEqual([{ path: "Fresh.md", create: true }]);
    composer.setQuery("cee");
    expect(composer.options()[0]).toEqual({ path: "Sub/Cee.md", create: false });
  });

  it("offers only existing notes when merging", async () => {
    await composer.mergeInto();
    composer.setQuery("Fresh");
    expect(composer.options()).toEqual([]);
  });

  it("extracts the selection after the confirmation", async () => {
    const preview = vi.spyOn(backend, "extractPreview").mockResolvedValue([{ path: "B.md", action: "append", links: 0 }]);
    const extract = vi.spyOn(backend, "extractText").mockResolvedValue([]);
    await composer.extractSelection();
    expect(await composer.choose({ path: "B.md", create: false })).toBe(true);
    const what = { kind: "selection", start: 2, end: 5, expected: "abc" };
    expect(preview).toHaveBeenCalledWith("/v/A.md", "/v/B.md", what, false);
    expect(extract).toHaveBeenCalledWith("/v/A.md", "/v/B.md", what, false);
    expect(vi.mocked(ask).mock.calls[0][0]).toContain("B.md (text added)");
    expect(doc.reload).toHaveBeenCalled();
    expect(composer.visible()).toBe(false);
  });

  it("passes the embed setting and the heading line", async () => {
    settings.extractEmbed.set(true);
    vi.spyOn(backend, "extractPreview").mockResolvedValue([]);
    const extract = vi.spyOn(backend, "extractText").mockResolvedValue([]);
    await composer.extractHeading();
    expect(composer.query()).toBe("Idea");
    await composer.choose({ path: "Idea.md", create: true });
    expect(extract).toHaveBeenCalledWith("/v/A.md", "/v/Idea.md", { kind: "heading", line: 3 }, true);
  });

  it("changes nothing when the user declines", async () => {
    vi.spyOn(backend, "mergePreview").mockResolvedValue([]);
    const merge = vi.spyOn(backend, "mergeNote").mockResolvedValue([]);
    vi.mocked(ask).mockResolvedValue(false);
    await composer.mergeInto();
    expect(await composer.choose({ path: "B.md", create: false })).toBe(false);
    expect(merge).not.toHaveBeenCalled();
  });

  it("merges, then opens the target", async () => {
    vi.spyOn(backend, "mergePreview").mockResolvedValue([]);
    const merge = vi.spyOn(backend, "mergeNote").mockResolvedValue([]);
    await composer.mergeInto();
    await composer.choose({ path: "B.md", create: false });
    expect(merge).toHaveBeenCalledWith("/v/A.md", "/v/B.md");
    expect(doc.open).toHaveBeenCalledWith("/v/B.md", { addToHistory: false });
  });
});

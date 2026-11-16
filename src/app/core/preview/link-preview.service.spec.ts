import { Injector, signal } from "@angular/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

import { backend } from "../file/backend";
import { DocumentService } from "../file/document.service";
import { MarkdownService } from "../markdown/markdown.service";
import { SettingsService } from "../settings/settings.service";
import { WorkspaceService } from "../workspace/workspace.service";
import { LinkPreviewService, PREVIEW_DELAY_MS, PREVIEW_HIDE_MS } from "./link-preview.service";

const anchor = { left: 10, top: 10, bottom: 30 };

function setup(mode: "modifier" | "always" = "modifier") {
  const notes: Record<string, string> = {
    "/v/A.md": "# A\n\nintro\n\n## Sec\n\nsection text\n",
    "/v/img.png": "",
  };
  const read = vi.spyOn(backend, "readTextFile").mockImplementation(async (p) => {
    if (!(p in notes)) throw new Error("nope");
    return notes[p];
  });
  const render = vi.fn((text: string) => `<p>${text.trim()}</p>`);
  const files = signal<readonly string[] | null>(["A.md", "img.png"]);
  const injector = Injector.create({
    providers: [
      { provide: SettingsService, useValue: { linkPreview: signal(mode), math: signal(true) } },
      { provide: WorkspaceService, useValue: { vaultRoot: signal("/v"), vaultFiles: files } },
      { provide: DocumentService, useValue: { wikiRoot: () => null } },
      { provide: MarkdownService, useValue: { render } },
      { provide: LinkPreviewService, useClass: LinkPreviewService, deps: [] },
    ],
  });
  return { service: injector.get(LinkPreviewService), notes, read, render, files };
}

const settle = async (ms: number) => {
  await vi.advanceTimersByTimeAsync(ms);
};

describe("LinkPreviewService", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("shows a resolved link after the delay when the modifier is held", async () => {
    const { service } = setup();
    service.hover("A", anchor, true);
    expect(service.shown()).toBeNull();
    await settle(PREVIEW_DELAY_MS);
    expect(service.shown()).toMatchObject({ html: "<p># A\n\nintro\n\n## Sec\n\nsection text</p>", path: "/v/A.md" });
  });

  it("shows nothing without the modifier in modifier mode, and always in always mode", async () => {
    const a = setup("modifier");
    a.service.hover("A", anchor, false);
    await settle(PREVIEW_DELAY_MS);
    expect(a.service.shown()).toBeNull();
    const b = setup("always");
    b.service.hover("A", anchor, false);
    await settle(PREVIEW_DELAY_MS);
    expect(b.service.shown()).not.toBeNull();
  });

  it("shows only the section of a heading link", async () => {
    const { service } = setup("always");
    service.hover("A#Sec", anchor, false);
    await settle(PREVIEW_DELAY_MS);
    expect(service.shown()?.html).toBe("<p>## Sec\n\nsection text</p>");
  });

  it("shows nothing for unresolved, non-note or missing-section targets", async () => {
    const { service } = setup("always");
    for (const t of ["Missing", "img.png", "A#Nope", "#Local"]) {
      service.hover(t, anchor, false);
      await settle(PREVIEW_DELAY_MS);
      expect(service.shown()).toBeNull();
      service.close();
    }
  });

  it("closes shortly after the pointer leaves, unless it comes back to the popover", async () => {
    const { service } = setup("always");
    service.hover("A", anchor, false);
    await settle(PREVIEW_DELAY_MS);
    service.leave();
    service.keep();
    await settle(PREVIEW_HIDE_MS * 2);
    expect(service.shown()).not.toBeNull();
    service.leave();
    await settle(PREVIEW_HIDE_MS);
    expect(service.shown()).toBeNull();
  });

  it("does not open when the pointer left before the delay", async () => {
    const { service } = setup("always");
    service.hover("A", anchor, false);
    service.leave();
    await settle(PREVIEW_DELAY_MS + PREVIEW_HIDE_MS);
    expect(service.shown()).toBeNull();
  });

  it("renders a note once until its file changes", async () => {
    const { service, notes, render } = setup("always");
    await service.render("A");
    await service.render("A");
    expect(render).toHaveBeenCalledTimes(1);
    notes["/v/A.md"] = "# A\n\nchanged\n";
    const again = await service.render("A");
    expect(render).toHaveBeenCalledTimes(2);
    expect(again?.html).toContain("changed");
  });

  it("caches each section on its own", async () => {
    const { service, render } = setup("always");
    await service.render("A");
    await service.render("A#Sec");
    await service.render("A#Sec");
    expect(render).toHaveBeenCalledTimes(2);
  });

  it("renders again when the vault files changed", async () => {
    const { service, render, files } = setup("always");
    await service.render("A");
    files.set(["A.md", "img.png", "B.md"]);
    await service.render("A");
    expect(render).toHaveBeenCalledTimes(2);
  });
});

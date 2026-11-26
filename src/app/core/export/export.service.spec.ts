// @vitest-environment jsdom
import "@angular/compiler";
import { TestBed } from "@angular/core/testing";
import { BrowserTestingModule, platformBrowserTesting } from "@angular/platform-browser/testing";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke,
  convertFileSrc: (path: string) => `asset://localhost/${encodeURIComponent(path)}`,
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn(), ask: vi.fn() }));

import { signal } from "@angular/core";
import { open } from "@tauri-apps/plugin-dialog";
import { WorkspaceService } from "../workspace/workspace.service";
import { SettingsService } from "../settings/settings.service";
import { MermaidRenderer } from "../markdown/mermaid-renderer";
import { ExportService } from "./export.service";
import type { ExportOptions } from "./export-core";

const options: ExportOptions = { dark: false, pageSize: "A4", pageBreaks: true };

const NOTES: Record<string, string> = {
  "/v/Part.md": "Embedded %%hidden embed comment%% text\n",
};

describe("ExportService", () => {
  beforeAll(() => TestBed.initTestEnvironment(BrowserTestingModule, platformBrowserTesting()));

  beforeEach(() => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        {
          provide: SettingsService,
          useValue: {
            math: signal(true),
            exportDark: signal(false),
            exportPageSize: signal("A4"),
            exportPageBreaks: signal(true),
          },
        },
      ],
    });
    invoke.mockReset();
    invoke.mockImplementation(async (cmd: string, args: Record<string, string>) => {
      if (cmd === "read_text_file") return NOTES[args["path"]] ?? "";
      if (cmd === "read_data_uri") return "data:image/png;base64,AAAA";
      return null;
    });
  });

  const build = (text: string) =>
    TestBed.inject(ExportService).build(
      {
        path: "/v/Note.md",
        text,
        vaultRoot: "/v",
        vaultFiles: ["Note.md", "Part.md", "Other.md"],
        wikiRoot: null,
      },
      options,
    );

  it("writes one self-contained page: images inline, wikilinks plain, embeds resolved", async () => {
    const html = await build(
      "# Title\n\nSee [[Other|the other note]] and [[Missing]].\n\n![pic](pic.png)\n\n![[Part]]\n",
    );
    expect(html).toContain("<h1");
    expect(html).toContain("the other note");
    expect(html).not.toContain("wikilink");
    expect(html).toContain('src="data:image/png;base64,AAAA"');
    expect(html).not.toContain("asset://");
    expect(html).toContain("Embedded");
    expect(html).not.toMatch(/<script|<link|hidden embed comment/u);
  });

  it("shows a placeholder for a base block, also in an embedded note", async () => {
    NOTES["/v/Part.md"] = "```base\nviews: [] # embedded source\n```\n";
    try {
      const html = await build("```base\nviews: [] # own source\n```\n\n![[Part]]\n");
      expect(html.match(/<p class="base-placeholder">/gu)).toHaveLength(2);
      expect(html).not.toMatch(/own source|embedded source|data-base=/u);
    } finally {
      NOTES["/v/Part.md"] = "Embedded %%hidden embed comment%% text\n";
    }
  });

  it("leaves comments out", async () => {
    const html = await build("A %%inline secret%% B\n\n%%\nblock secret\n%%\n");
    expect(html).toContain("A");
    expect(html).not.toContain("secret");
  });

  it("removes its working copy from the page", async () => {
    await build("text");
    expect(document.body.children).toHaveLength(0);
  });

  it("writes the HTML of a request to its file", async () => {
    NOTES["/v/Note.md"] = "# Hi\n";
    const file = await TestBed.inject(ExportService).runRequest({
      note: "/v/Note.md",
      vaultRoot: "/v",
      format: "html",
      out: "/out/Note.html",
      dark: true,
      pageSize: "letter",
      headless: true,
    });
    expect(file).toBe("/out/Note.html");
    const write = invoke.mock.calls.find((c) => c[0] === "write_export_file")!;
    expect(write[1].path).toBe("/out/Note.html");
    expect(write[1].content).toContain('class="app-dark"');
    expect(write[1].content).toContain("size: Letter");
  });

  it("draws a timeline that is wider than the page vertically, without a script", async () => {
    const render = vi
      .spyOn(MermaidRenderer.prototype, "render")
      .mockImplementation(async (root) => {
        for (const pre of Array.from(root.querySelectorAll("pre.mermaid"))) {
          const figure = document.createElement("div");
          figure.className = "mermaid-diagram";
          figure.dataset["source"] = pre.textContent ?? "";
          figure.innerHTML = '<svg viewBox="0 0 3390 500"></svg>';
          pre.replaceWith(figure);
        }
      });
    const html = await build("```mermaid\ntimeline\n  2002 : LinkedIn\n```\n");
    render.mockRestore();
    expect(html).toContain('<div class="timeline-period">2002</div>');
    expect(html).not.toContain("<svg");
    expect(html).not.toContain("<script");
  });

  describe("exportSite", () => {
    function withVault(root: string | null): ExportService {
      TestBed.overrideProvider(WorkspaceService, { useValue: { vaultRoot: () => root } });
      return TestBed.inject(ExportService);
    }

    it("asks for the folder and the target and exports", async () => {
      vi.mocked(open).mockResolvedValueOnce("/v/docs").mockResolvedValueOnce("/site");
      invoke.mockImplementation(async (cmd: string) => (cmd === "export_site" ? 7 : null));
      const result = await withVault("/v").exportSite();
      expect(result).toEqual({ out: "/site", pages: 7 });
      expect(invoke).toHaveBeenCalledWith("export_site", {
        folder: "/v/docs",
        out: "/site",
        exclude: [],
      });
    });

    it("does nothing when a dialog is cancelled", async () => {
      vi.mocked(open).mockResolvedValueOnce("/v/docs").mockResolvedValueOnce(null);
      expect(await withVault("/v").exportSite()).toBeNull();
      expect(invoke).not.toHaveBeenCalledWith("export_site", expect.anything());
    });

    it("needs a vault", async () => {
      await expect(withVault(null).exportSite()).rejects.toThrow("No vault");
    });
  });
});

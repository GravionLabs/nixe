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
import { SettingsService } from "../settings/settings.service";
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
});

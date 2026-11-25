// @vitest-environment jsdom
// The silent PDF of `nixe export --out` (#599). It replaces the document of the window, so it
// has a spec file of its own.
import "@angular/compiler";
import { signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { BrowserTestingModule, platformBrowserTesting } from "@angular/platform-browser/testing";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke,
  convertFileSrc: (path: string) => `asset://localhost/${encodeURIComponent(path)}`,
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn(), ask: vi.fn() }));

import { SettingsService } from "../settings/settings.service";
import { ExportService, showForPrint } from "./export.service";

const PAGE = `<!doctype html><html lang="en" class="app-dark" style="color-scheme: dark">
<head><title>Note</title><style>body { margin: 0; }</style></head>
<body><article class="markdown-body"><img src="data:image/png;base64,AAAA" loading="lazy"></article></body></html>`;

const tick = () => new Promise((resolve) => setTimeout(resolve));

describe("PDF export into a file", () => {
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
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "read_text_file") return "# Hi\n";
      if (cmd === "list_vault_files") return [];
      return null;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    Reflect.deleteProperty(document, "fonts");
  });

  const request = {
    note: "/v/Note.md",
    vaultRoot: "/v",
    format: "pdf" as const,
    out: "/out/Note.pdf",
    dark: null,
    pageSize: "a5",
    headless: true,
  };

  it("shows the document and prints it into the file with its page size", async () => {
    document.body.innerHTML = "<app-root>the app</app-root>";
    const file = await TestBed.inject(ExportService).runRequest(request);
    expect(file).toBe("/out/Note.pdf");
    expect(invoke).toHaveBeenCalledWith("print_export_pdf", {
      path: "/out/Note.pdf",
      pageSize: "A5",
    });
    expect(invoke).not.toHaveBeenCalledWith("write_export_file", expect.anything());
    expect(document.querySelector("app-root")).toBeNull();
    expect(document.querySelector(".markdown-body h1")?.textContent).toContain("Hi");
    expect(document.head.textContent).toContain("size: A5");
  });

  it("fails when the print fails", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "print_export_pdf") throw "/out/Note.pdf: no PDF was written";
      return cmd === "read_text_file" ? "x" : [];
    });
    await expect(TestBed.inject(ExportService).runRequest(request)).rejects.toContain(
      "no PDF was written",
    );
  });

  it("waits for the images and the fonts", async () => {
    vi.spyOn(HTMLImageElement.prototype, "complete", "get").mockReturnValue(false);
    let fontLoaded: () => void = () => undefined;
    const load = vi.fn(() => new Promise<void>((resolve) => (fontLoaded = resolve)));
    Object.defineProperty(document, "fonts", {
      configurable: true,
      value: Object.assign([{ load }], { ready: Promise.resolve() }),
    });
    let done = false;
    const shown = showForPrint(PAGE).then(() => (done = true));
    await tick();
    expect(done).toBe(false);
    expect(load).not.toHaveBeenCalled();
    const image = document.querySelector("img")!;
    expect(image.loading).toBe("eager");
    image.dispatchEvent(new Event("load"));
    await tick();
    expect(load).toHaveBeenCalled();
    expect(done).toBe(false);
    fontLoaded();
    await shown;
    expect(done).toBe(true);
  });

  it("goes on when an image is broken", async () => {
    vi.spyOn(HTMLImageElement.prototype, "complete", "get").mockReturnValue(false);
    const shown = showForPrint(PAGE);
    await tick();
    document.querySelector("img")!.dispatchEvent(new Event("error"));
    await expect(shown).resolves.toBeUndefined();
  });

  it("keeps the look of the export when the theme of the app changes the root", async () => {
    // jsdom loads no image and never reports one as complete.
    vi.spyOn(HTMLImageElement.prototype, "complete", "get").mockReturnValue(true);
    await showForPrint(PAGE);
    const root = document.documentElement;
    expect(root.className).toBe("app-dark");
    root.classList.remove("app-dark");
    root.setAttribute("data-theme", "light");
    await tick();
    expect(root.className).toBe("app-dark");
    expect(root.hasAttribute("data-theme")).toBe(false);
    expect(root.getAttribute("style")).toBe("color-scheme: dark");
  });
});

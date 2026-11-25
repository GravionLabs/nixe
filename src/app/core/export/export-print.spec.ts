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

  it("prints a folder note by note, reports each and goes on after a failure", async () => {
    document.head.innerHTML = "<title>Nixe</title><style>.app { color: red; }</style>";
    document.body.innerHTML = "<app-root>the app</app-root>";
    const appStyle = document.querySelector("style")!;
    const printed: { path: string; head: string; appStyleOff: boolean; text: string }[] = [];
    invoke.mockImplementation(async (cmd: string, args: { path: string }) => {
      if (cmd === "read_text_file") {
        if (args.path === "/v/Gone.md") throw "no such file";
        return `# Text of ${args.path}`;
      }
      if (cmd === "print_export_pdf") {
        printed.push({
          path: args.path,
          head: document.head.textContent ?? "",
          appStyleOff: appStyle.sheet!.disabled,
          text: document.querySelector(".markdown-body h1")?.textContent ?? "",
        });
        if (args.path === "/out/Full.pdf") throw "disk full";
      }
      return cmd === "list_vault_files" ? [] : null;
    });
    const note = (name: string, out = name) => ({
      note: `/v/${name}.md`,
      name: `${name}.md`,
      out: `/out/${out}.pdf`,
    });
    const notes = [note("A"), note("Gone"), note("Full"), note("Twin", "A"), note("B")];

    const failure = await TestBed.inject(ExportService)
      .runRequest({ ...request, note: "/v", out: "/out", notes })
      .catch((err: unknown) => String(err));

    expect(failure).toBe("3 of 5 notes could not be exported");
    expect(printed.map((p) => p.path)).toEqual(["/out/A.pdf", "/out/Full.pdf", "/out/B.pdf"]);
    expect(printed[2].text).toContain("Text of /v/B.md");
    expect(printed[2].appStyleOff).toBe(true);
    expect(printed[2].head).toContain("size: A5");
    expect(printed[2].head).not.toContain("Nixe");
    const reports = invoke.mock.calls.filter((c) => c[0] === "report_export_note").map((c) => c[1]);
    expect(reports.map((r) => [r.index, r.total, r.name, r.written])).toEqual([
      [1, 5, "A.md", "/out/A.pdf"],
      [2, 5, "Gone.md", null],
      [3, 5, "Full.md", null],
      [4, 5, "Twin.md", null],
      [5, 5, "B.md", "/out/B.pdf"],
    ]);
    expect(reports[0].error).toBeNull();
    expect(reports[1].error).toContain("no such file");
    expect(reports[2].error).toContain("disk full");
    expect(reports[3].error).toContain("already the PDF of A.md");
    // The app is back, with its styles.
    expect(document.querySelector("app-root")?.textContent).toBe("the app");
    expect(appStyle.isConnected).toBe(true);
    expect(appStyle.sheet!.disabled).toBe(false);
    expect(document.title).toBe("Nixe");
    expect(document.head.querySelectorAll("style")).toHaveLength(1);
  });

  it("answers a folder without a failed note with nothing more to print", async () => {
    const notes = [{ note: "/v/A.md", name: "A.md", out: "/out/A.pdf" }];
    await expect(
      TestBed.inject(ExportService).runRequest({ ...request, note: "/v", out: "/out", notes }),
    ).resolves.toBe("");
  });

  it("brings the app and its root back after a print", async () => {
    vi.spyOn(HTMLImageElement.prototype, "complete", "get").mockReturnValue(true);
    const root = document.documentElement;
    root.className = "app-light";
    document.head.innerHTML = "<title>Nixe</title>";
    document.body.innerHTML = "<app-root></app-root>";
    const restore = await showForPrint(PAGE);
    expect(document.title).toBe("Note");
    restore();
    await tick();
    expect(root.className).toBe("app-light");
    expect(document.title).toBe("Nixe");
    expect(document.querySelector(".markdown-body")).toBeNull();
    expect(document.querySelector("app-root")).not.toBeNull();
    // The guard of the export look is gone.
    root.className = "app-other";
    await tick();
    expect(root.className).toBe("app-other");
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
    await expect(shown).resolves.toBeTypeOf("function");
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

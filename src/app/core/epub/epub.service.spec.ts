// @vitest-environment jsdom
import "@angular/compiler";
import { readFileSync } from "node:fs";
import { TestBed } from "@angular/core/testing";
import { BrowserTestingModule, platformBrowserTesting } from "@angular/platform-browser/testing";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

import { WorkspaceService } from "../workspace/workspace.service";
import { EpubService } from "./epub.service";

describe("EpubService", () => {
  beforeAll(() => {
    TestBed.initTestEnvironment(BrowserTestingModule, platformBrowserTesting());
  });

  beforeEach(() => {
    localStorage.clear();
    invoke.mockReset();
    TestBed.resetTestingModule();
  });

  it("reads the book through the core with the further roots and parses it", async () => {
    invoke.mockResolvedValue([...readFileSync("fixtures/books/sample.epub")]);
    TestBed.configureTestingModule({
      providers: [
        {
          provide: WorkspaceService,
          useValue: {
            extraRoots: () => [{ dirPath: "/books" }, { dirPath: null }],
          },
        },
      ],
    });

    const loaded = await TestBed.inject(EpubService).load("/books/sample.epub");

    expect(invoke).toHaveBeenCalledWith("read_epub", {
      path: "/books/sample.epub",
      roots: ["/books"],
    });
    expect(loaded.title).toBe("Nixe Sample Book");
    expect(loaded.book.toc?.map((item) => item.label)).toEqual(["Chapter 1", "Chapter 2"]);
  });

  it("passes the refusal of the core on", async () => {
    invoke.mockRejectedValue("outside the open roots and the vault: /x/a.epub");
    TestBed.configureTestingModule({
      providers: [{ provide: WorkspaceService, useValue: { extraRoots: () => [] } }],
    });

    await expect(TestBed.inject(EpubService).load("/x/a.epub")).rejects.toMatch("outside");
  });

  it("remembers the reading mode", () => {
    TestBed.configureTestingModule({
      providers: [{ provide: WorkspaceService, useValue: { extraRoots: () => [] } }],
    });
    const service = TestBed.inject(EpubService);
    expect(service.flow()).toBe("paginated");

    service.setFlow("scrolled");

    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [{ provide: WorkspaceService, useValue: { extraRoots: () => [] } }],
    });
    expect(TestBed.inject(EpubService).flow()).toBe("scrolled");
  });

  describe("reading position", () => {
    const workspace = {
      vaultRoot: () => "/home/me/Vault",
      extraRoots: () => [{ dirPath: "/books", name: "Books" }],
    };

    function service(): EpubService {
      TestBed.configureTestingModule({
        providers: [{ provide: WorkspaceService, useValue: workspace }],
      });
      return TestBed.inject(EpubService);
    }

    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it("reads the position by root name and relative path", async () => {
      invoke.mockResolvedValue(
        JSON.stringify({ root: "Books", path: "fiction/a.epub", cfi: "epubcfi(/6/4)" }),
      );

      expect(await service().position("/books/fiction/a.epub")).toBe("epubcfi(/6/4)");
      expect(invoke).toHaveBeenCalledWith("read_epub_position", { key: "Books:fiction/a.epub" });
    });

    it("names a book of the vault by the vault folder", async () => {
      invoke.mockResolvedValue(null);

      expect(await service().position("/home/me/Vault/a.epub")).toBeNull();
      expect(invoke).toHaveBeenCalledWith("read_epub_position", { key: "Vault:a.epub" });
    });

    it("ignores a missing, damaged, foreign or failing file without an error", async () => {
      const s = service();
      for (const text of [
        null,
        "{",
        "[]",
        "3",
        '{"cfi":3}',
        '{"root":"Books","path":"x","cfi":"c"}',
      ]) {
        invoke.mockResolvedValue(text);
        expect(await s.position("/books/a.epub")).toBeNull();
      }
      invoke.mockRejectedValue("no vault is open");
      expect(await s.position("/books/a.epub")).toBeNull();
      expect(await s.position("/elsewhere/a.epub")).toBeNull();
    });

    it("writes plain JSON once the position has rested, the last one only", () => {
      invoke.mockResolvedValue(undefined);
      const s = service();

      s.savePosition("/books/a.epub", "epubcfi(/6/2)");
      vi.advanceTimersByTime(500);
      s.savePosition("/books/a.epub", "epubcfi(/6/4)");
      vi.advanceTimersByTime(999);
      expect(invoke).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);

      expect(invoke).toHaveBeenCalledTimes(1);
      const [command, args] = invoke.mock.calls[0];
      expect(command).toBe("write_epub_position");
      expect(args.key).toBe("Books:a.epub");
      expect(JSON.parse(args.content)).toEqual({
        root: "Books",
        path: "a.epub",
        cfi: "epubcfi(/6/4)",
      });
    });

    it("flushes at once and a failed write is retried by the next change", async () => {
      invoke.mockRejectedValueOnce("disk full").mockResolvedValue(undefined);
      const s = service();
      // The backend also logs a failed command through `invoke`.
      const writes = () => invoke.mock.calls.filter(([c]) => c === "write_epub_position").length;

      s.savePosition("/books/a.epub", "c1");
      s.flushPosition("/books/a.epub");
      await Promise.resolve();
      s.flushPosition("/books/a.epub");
      expect(writes()).toBe(1);

      s.savePosition("/books/a.epub", "c2");
      vi.advanceTimersByTime(1000);
      expect(writes()).toBe(2);
    });
  });
});

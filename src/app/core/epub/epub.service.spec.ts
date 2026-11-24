// @vitest-environment jsdom
import "@angular/compiler";
import { readFileSync } from "node:fs";
import { TestBed } from "@angular/core/testing";
import { BrowserTestingModule, platformBrowserTesting } from "@angular/platform-browser/testing";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

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
});

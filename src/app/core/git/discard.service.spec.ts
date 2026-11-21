// @vitest-environment jsdom
import "@angular/compiler";
import { signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { BrowserTestingModule, platformBrowserTesting } from "@angular/platform-browser/testing";
import { ask } from "@tauri-apps/plugin-dialog";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), ask: vi.fn() }));

import { backend } from "../file/backend";
import { EditorService } from "../editor/editor.service";
import { TabsService } from "../tabs/tabs.service";
import { VaultUndoService } from "../workspace/vault-undo.service";
import { WorkspaceService } from "../workspace/workspace.service";
import { DiscardService, discardQuestion } from "./discard.service";
import { GitService } from "./git.service";

describe("discardQuestion", () => {
  it("names the note and what happens", () => {
    expect(discardQuestion({ path: "x/a.md", kind: "modified" })).toBe(
      'Discard the changes of "a"? The note goes back to the last saved version.',
    );
    expect(discardQuestion({ path: "b.md", kind: "added" })).toBe(
      'Discard "b"? The note is deleted.',
    );
    expect(discardQuestion({ path: "c.md", kind: "deleted" })).toBe(
      'Discard the deletion of "c"? The note is restored.',
    );
  });
});

describe("DiscardService", () => {
  const order: string[] = [];
  const offer = vi.fn();
  let service: DiscardService;

  beforeAll(() => {
    TestBed.initTestEnvironment(BrowserTestingModule, platformBrowserTesting());
  });

  beforeEach(() => {
    vi.restoreAllMocks();
    order.length = 0;
    offer.mockReset().mockImplementation(async () => void order.push("offer"));
    vi.mocked(ask).mockResolvedValue(true);
    vi.spyOn(backend, "gitDiscardNote").mockImplementation(async () => {
      order.push("discard");
      return { id: "c", kind: "discard", message: "discard changes: a.md" };
    });
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        { provide: WorkspaceService, useValue: { vaultRoot: signal("/v"), reloadTree: vi.fn() } },
        {
          provide: EditorService,
          useValue: { handle: { flush: vi.fn(async () => void order.push("flush")) } },
        },
        {
          provide: TabsService,
          useValue: { onExternalChange: vi.fn(async () => void order.push("tabs")) },
        },
        {
          provide: VaultUndoService,
          useValue: { author: () => ({ name: "A", email: null }), offer },
        },
        { provide: GitService, useValue: { refresh: vi.fn(async () => void order.push("git")) } },
      ],
    });
    service = TestBed.inject(DiscardService);
  });

  it("asks, writes pending typing first, discards, refreshes the tabs and offers Undo", async () => {
    expect(await service.discard({ path: "a.md", kind: "modified" })).toBe(true);
    expect(vi.mocked(ask).mock.calls[0][0]).toContain('"a"');
    expect(backend.gitDiscardNote).toHaveBeenCalledWith("a.md", { name: "A", email: null });
    expect(order).toEqual(["flush", "discard", "git", "tabs", "offer"]);
    expect(TestBed.inject(TabsService).onExternalChange).toHaveBeenCalledWith("/v/a.md");
  });

  it("changes nothing when the user declines", async () => {
    vi.mocked(ask).mockResolvedValue(false);
    expect(await service.discard({ path: "a.md", kind: "added" })).toBe(false);
    expect(order).toEqual([]);
  });

  it("refreshes the status and passes the error on when the backend refuses", async () => {
    vi.spyOn(backend, "gitDiscardNote").mockRejectedValue("a.md has no changes to discard");
    await expect(service.discard({ path: "a.md", kind: "modified" })).rejects.toBe(
      "a.md has no changes to discard",
    );
    expect(order).toContain("git");
    expect(offer).not.toHaveBeenCalled();
  });
});

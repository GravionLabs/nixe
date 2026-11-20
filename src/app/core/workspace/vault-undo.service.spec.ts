// @vitest-environment jsdom
import "@angular/compiler";
import { signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { BrowserTestingModule, platformBrowserTesting } from "@angular/platform-browser/testing";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { backend } from "../file/backend";
import { DocumentService } from "../file/document.service";
import { SettingsService } from "../settings/settings.service";
import { VaultUndoService } from "./vault-undo.service";
import { WorkspaceService } from "./workspace.service";

const op = { id: "c1", kind: "rename", message: "rename: a.md -> b.md, links in 9 notes" };

describe("VaultUndoService", () => {
  const workspace = { reloadTree: vi.fn() };
  const doc = { path: signal<string | null>("/v/a.md"), reload: vi.fn(), close: vi.fn() };
  let undo: VaultUndoService;

  beforeAll(() => {
    TestBed.initTestEnvironment(BrowserTestingModule, platformBrowserTesting());
  });

  beforeEach(() => {
    vi.restoreAllMocks();
    workspace.reloadTree = vi.fn().mockResolvedValue(undefined);
    doc.reload = vi.fn().mockResolvedValue(undefined);
    doc.close = vi.fn();
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        { provide: WorkspaceService, useValue: workspace },
        { provide: DocumentService, useValue: doc },
        {
          provide: SettingsService,
          useValue: { gitAuthorName: () => " Ann ", gitAuthorEmail: () => "" },
        },
      ],
    });
    undo = TestBed.inject(VaultUndoService);
  });

  it("passes the author of the settings, empty parts as null", () => {
    expect(undo.author()).toEqual({ name: "Ann", email: null });
  });

  it("offers Undo with the message of the commit", async () => {
    vi.spyOn(backend, "lastVaultOperation").mockResolvedValue(op);
    await undo.offer();
    expect(undo.notice()).toEqual({ text: op.message, undo: true, error: false });
  });

  it("offers nothing without Git", async () => {
    vi.spyOn(backend, "lastVaultOperation").mockResolvedValue(null);
    await undo.offer();
    expect(undo.notice()).toBeNull();
  });

  it("offers nothing when the lookup fails", async () => {
    vi.spyOn(backend, "lastVaultOperation").mockRejectedValue("boom");
    await undo.offer();
    expect(undo.notice()).toBeNull();
  });

  it("reverts, reloads the tree and the open note and says so", async () => {
    const revert = vi.spyOn(backend, "undoVaultOperation").mockResolvedValue(op);
    await expect(undo.undo()).resolves.toEqual(op);
    expect(revert).toHaveBeenCalledWith({ name: "Ann", email: null });
    expect(workspace.reloadTree).toHaveBeenCalled();
    expect(doc.reload).toHaveBeenCalled();
    expect(undo.notice()).toEqual({ text: `Undone: ${op.message}`, undo: false, error: false });
  });

  it("closes the open note when it is gone after the undo", async () => {
    vi.spyOn(backend, "undoVaultOperation").mockResolvedValue(op);
    doc.reload = vi.fn().mockRejectedValue("gone");
    await undo.undo();
    expect(doc.close).toHaveBeenCalled();
  });

  it("shows the refusal of a conflicting revert and reloads nothing", async () => {
    vi.spyOn(backend, "undoVaultOperation").mockRejectedValue("cannot undo: conflict");
    await expect(undo.undo()).resolves.toBeNull();
    expect(workspace.reloadTree).not.toHaveBeenCalled();
    expect(undo.notice()).toEqual({ text: "cannot undo: conflict", undo: false, error: true });
  });
});

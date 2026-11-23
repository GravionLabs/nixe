// @vitest-environment jsdom
import "@angular/compiler";
import { signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { BrowserTestingModule, platformBrowserTesting } from "@angular/platform-browser/testing";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

import type { VaultLayout } from "../file/backend";
import { backend } from "../file/backend";
import { FolderRolesService } from "./folder-roles.service";
import { WorkspaceService } from "./workspace.service";

const layout = (folders: VaultLayout["folders"]): VaultLayout => ({
  language: null,
  folders,
  files: {},
});
const entry = (path: string, description: string | null = null, missing = false) => ({
  path,
  description,
  missing,
});

describe("FolderRolesService", () => {
  const vaultRoot = signal<string | null>("/v");
  let roles: FolderRolesService;

  beforeAll(() => TestBed.initTestEnvironment(BrowserTestingModule, platformBrowserTesting()));

  beforeEach(async () => {
    vi.restoreAllMocks();
    vaultRoot.set("/v");
    vi.spyOn(backend, "vaultLayout").mockResolvedValue(
      layout({ inbox: entry("In"), exams: entry("Work/Ex", "all exams", true) }),
    );
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [{ provide: WorkspaceService, useValue: { vaultRoot } }],
    });
    roles = TestBed.inject(FolderRolesService);
    await roles.reload();
  });

  it("finds the role of a folder by its absolute path", () => {
    expect(roles.roleOf("/v/In")?.role).toBe("inbox");
    expect(roles.roleOf("/v/Other")).toBeNull();
    expect(roles.roleOf("/elsewhere/In")).toBeNull();
    expect(roles.roleOf("/v")).toBeNull();
  });

  it("has no roles without a vault or when the layout cannot be read", async () => {
    vaultRoot.set(null);
    await roles.reload();
    expect(roles.roles()).toEqual([]);
    vaultRoot.set("/v");
    vi.spyOn(backend, "vaultLayout").mockRejectedValue("boom");
    await roles.reload();
    expect(roles.roles()).toEqual([]);
  });

  it("puts the description into the tooltip", () => {
    expect(roles.tooltip(roles.roles()[0])).toBe("Folder role: inbox");
    expect(roles.tooltip(roles.roles()[1])).toBe("Folder role: exams: all exams");
  });

  it("opens the dialog with the current role and closes it", () => {
    roles.openDialog("/v/In");
    expect(roles.dialog()).toMatchObject({ rel: "In", current: { role: "inbox" } });
    roles.closeDialog();
    expect(roles.dialog()).toBeNull();
    roles.openDialog("/v");
    expect(roles.dialog()).toBeNull();
  });

  it("sets a standard role without a description", async () => {
    const set = vi
      .spyOn(backend, "setFolderRole")
      .mockResolvedValue(layout({ inbox: entry("In"), archive: entry("Old") }));
    await roles.set("Old", "archive", " ");
    expect(set).toHaveBeenCalledWith("Old", "archive", null);
    expect(roles.roles().map((r) => r.role)).toEqual(["inbox", "archive"]);
  });

  it("needs a description for an own role and a name for every role", async () => {
    const set = vi.spyOn(backend, "setFolderRole");
    await expect(roles.set("Own", "vault-inbox", "")).rejects.toThrow("description");
    await expect(roles.set("Own", " ", "x")).rejects.toThrow("name");
    expect(set).not.toHaveBeenCalled();
  });

  it("replaces the role of a folder, but not with a name that another folder has", async () => {
    const remove = vi.spyOn(backend, "removeFolderRole").mockResolvedValue(layout({}));
    const set = vi
      .spyOn(backend, "setFolderRole")
      .mockResolvedValue(layout({ areas: entry("In") }));
    await expect(roles.set("In", "exams", "x")).rejects.toThrow("already set on Work/Ex");
    expect(remove).not.toHaveBeenCalled();
    await roles.set("In", "areas", "");
    expect(remove).toHaveBeenCalledWith("In");
    expect(set).toHaveBeenCalledWith("In", "areas", null);
  });

  it("keeps the role of the folder when only the description changes", async () => {
    const remove = vi.spyOn(backend, "removeFolderRole");
    const set = vi.spyOn(backend, "setFolderRole").mockResolvedValue(layout({}));
    await roles.set("Work/Ex", "exams", "new");
    expect(remove).not.toHaveBeenCalled();
    expect(set).toHaveBeenCalledWith("Work/Ex", "exams", "new");
  });

  it("passes the error of the backend on and keeps the roles", async () => {
    vi.spyOn(backend, "setFolderRole").mockRejectedValue("../x is outside the vault");
    await expect(roles.set("../x", "inbox2", "x")).rejects.toBe("../x is outside the vault");
    expect(roles.roles().map((r) => r.role)).toEqual(["inbox", "exams"]);
  });

  it("removes a role", async () => {
    const remove = vi
      .spyOn(backend, "removeFolderRole")
      .mockResolvedValue(layout({ exams: entry("Work/Ex") }));
    await roles.remove("In");
    expect(remove).toHaveBeenCalledWith("In");
    expect(roles.roles().map((r) => r.role)).toEqual(["exams"]);
  });

  it("warns about the roles in a deleted folder and below it", () => {
    expect(roles.deleteWarning("/v/Other")).toBeNull();
    expect(roles.deleteWarning("/v/Work")).toContain("exams (Work/Ex)");
    expect(roles.deleteWarning("/v/Work/Ex")).toContain("stays in .nixe/config.json");
    expect(roles.deleteWarning("/v/Wor")).toBeNull();
  });
});

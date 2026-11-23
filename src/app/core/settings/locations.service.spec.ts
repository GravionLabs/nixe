// @vitest-environment jsdom
import "@angular/compiler";
import { TestBed } from "@angular/core/testing";
import { BrowserTestingModule, platformBrowserTesting } from "@angular/platform-browser/testing";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { backend } from "../file/backend";
import { BUILTIN_LOCATIONS, LocationsService } from "./locations.service";

describe("LocationsService", () => {
  const list = vi.spyOn(backend, "locationsList");
  const set = vi.spyOn(backend, "locationsSet");
  const remove = vi.spyOn(backend, "locationsRemove");
  let service: LocationsService;

  beforeAll(() => TestBed.initTestEnvironment(BrowserTestingModule, platformBrowserTesting()));

  beforeEach(() => {
    list.mockReset().mockResolvedValue({ variables: { Zoo: "/z", Books: "/b" } });
    set.mockReset();
    remove.mockReset();
    TestBed.resetTestingModule();
    service = TestBed.inject(LocationsService);
  });

  it("lists the variables of the device by name, read once", async () => {
    expect(service.variables()).toEqual([]);
    await service.load();
    await service.load();
    expect(service.variables()).toEqual([
      { name: "Books", path: "/b" },
      { name: "Zoo", path: "/z" },
    ]);
    expect(list).toHaveBeenCalledTimes(1);
  });

  it("reads again after a failed read", async () => {
    list.mockRejectedValueOnce("no app data");
    await service.load();
    expect(service.variables()).toEqual([]);
    await service.load();
    expect(service.variables()).toHaveLength(2);
  });

  it("adds, edits and removes a variable through the backend and shows the result", async () => {
    set.mockResolvedValueOnce({ variables: { Books: "/b" } });
    await service.save(" Books ", " /b ");
    expect(set).toHaveBeenCalledWith("Books", "/b", null);
    expect(service.variables()).toEqual([{ name: "Books", path: "/b" }]);
    set.mockResolvedValueOnce({ variables: { Library: "/c" } });
    await service.save("Library", "/c", "Books");
    expect(set).toHaveBeenLastCalledWith("Library", "/c", "Books");
    expect(service.variables()).toEqual([{ name: "Library", path: "/c" }]);
    remove.mockResolvedValueOnce({ variables: {} });
    await service.remove("Library");
    expect(remove).toHaveBeenCalledWith("Library");
    expect(service.variables()).toEqual([]);
  });

  it("keeps the list and rejects with the reason when the backend refuses", async () => {
    await service.load();
    set.mockRejectedValueOnce("$Home is a built-in variable and cannot be redefined");
    await expect(service.save("Home", "/h")).rejects.toContain("built-in");
    expect(service.variables()).toHaveLength(2);
  });

  it("names the built-in variables", () => {
    expect(BUILTIN_LOCATIONS).toEqual(["Home", "Documents", "OneDrive", "iCloud"]);
  });
});

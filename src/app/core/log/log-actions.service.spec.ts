// @vitest-environment jsdom
import "@angular/compiler";
import { TestBed } from "@angular/core/testing";
import { BrowserTestingModule, platformBrowserTesting } from "@angular/platform-browser/testing";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const { invoke, reveal } = vi.hoisted(() => ({ invoke: vi.fn(), reveal: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ revealItemInDir: reveal }));

import { ACTIVE_TAB_PROVIDERS, TabsService } from "../tabs/tabs.service";
import { LogActionsService, folderOf } from "./log-actions.service";

describe("LogActionsService", () => {
  let logs: LogActionsService;
  let tabs: TabsService;
  const writeText = vi.fn();

  beforeAll(() => TestBed.initTestEnvironment(BrowserTestingModule, platformBrowserTesting()));

  beforeEach(() => {
    window.matchMedia ??= (() => ({ matches: false, addEventListener: vi.fn() })) as never;
    invoke.mockReset();
    reveal.mockReset();
    writeText.mockReset();
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ providers: [...ACTIVE_TAB_PROVIDERS] });
    logs = TestBed.inject(LogActionsService);
    tabs = TestBed.inject(TabsService);
  });

  it("shows the log in a tab of its own, once", () => {
    logs.show();
    const tab = tabs.openView("log");
    expect(tab.view()).toBe("log");
    expect(tabs.panes().flatMap((p) => p.tabs.filter((t) => t.view() === "log"))).toHaveLength(1);
  });

  it("copies the last 500 lines", async () => {
    invoke.mockResolvedValue("a\nb\nc");
    await logs.copy();
    expect(invoke).toHaveBeenCalledWith("log_read", { lines: 500 });
    expect(writeText).toHaveBeenCalledWith("a\nb\nc");
    expect(tabs.notice()).toBe("Copied the last 3 lines of the log.");
  });

  it("says so when there is nothing to copy or the copy fails", async () => {
    invoke.mockResolvedValueOnce("");
    await logs.copy();
    expect(writeText).not.toHaveBeenCalled();
    expect(tabs.notice()).toBe("The log is empty.");
    invoke.mockRejectedValueOnce("denied");
    await logs.copy();
    expect(tabs.notice()).toContain("Copy failed");
  });

  it("reveals the log file in the file manager", async () => {
    invoke.mockResolvedValue("/logs/nixe.log");
    await logs.reveal();
    expect(reveal).toHaveBeenCalledWith("/logs/nixe.log");
  });

  it("reads the log folder for the settings page", async () => {
    invoke.mockResolvedValue("/home/me/logs/nixe.log");
    await logs.loadFolder();
    expect(logs.folder()).toBe("/home/me/logs");
    invoke.mockRejectedValue("no tauri");
    await expect(logs.loadFolder()).resolves.toBeUndefined();
  });

  it("applies a level at once and survives a missing backend", async () => {
    invoke.mockResolvedValue("debug");
    await logs.setLevel("debug");
    expect(invoke).toHaveBeenCalledWith("log_set_level", { level: "debug" });
    invoke.mockRejectedValue("no tauri");
    await expect(logs.setLevel("warn")).resolves.toBeUndefined();
  });

  it("cuts the folder from a path of either kind", () => {
    expect(folderOf("/a/b/nixe.log")).toBe("/a/b");
    expect(folderOf("C:\\a\\logs\\nixe.log")).toBe("C:\\a\\logs");
    expect(folderOf("nixe.log")).toBe("nixe.log");
  });
});

// @vitest-environment jsdom
import "@angular/compiler";
import { TestBed } from "@angular/core/testing";
import { BrowserTestingModule, platformBrowserTesting } from "@angular/platform-browser/testing";
import { getVersion } from "@tauri-apps/api/app";
import { relaunch } from "@tauri-apps/plugin-process";
import { check } from "@tauri-apps/plugin-updater";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/app", () => ({ getVersion: vi.fn() }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: vi.fn() }));
vi.mock("@tauri-apps/plugin-updater", () => ({ check: vi.fn(), Update: class {} }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { EditorService } from "../editor/editor.service";
import { UpdateService } from "./update.service";

function fakeUpdate(version: string, download = vi.fn().mockResolvedValue(undefined)) {
  return { version, body: "notes", downloadAndInstall: download };
}

describe("UpdateService", () => {
  const editor = { handle: { flush: vi.fn(), dirty: vi.fn() } as { flush: ReturnType<typeof vi.fn>; dirty: ReturnType<typeof vi.fn> } | null };
  let updater: UpdateService;

  beforeAll(() => {
    TestBed.initTestEnvironment(BrowserTestingModule, platformBrowserTesting());
  });

  beforeEach(() => {
    vi.resetAllMocks();
    editor.handle = { flush: vi.fn().mockResolvedValue(undefined), dirty: vi.fn().mockReturnValue(false) };
    vi.mocked(getVersion).mockResolvedValue("1.0.0");
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ providers: [{ provide: EditorService, useValue: editor }] });
    updater = TestBed.inject(UpdateService);
  });

  it("makes no network call until a check is requested", async () => {
    await updater.init();
    expect(updater.version()).toBe("1.0.0");
    expect(check).not.toHaveBeenCalled();
    expect(updater.phase()).toBe("idle");
  });

  it("offers a newer version with its notes", async () => {
    vi.mocked(check).mockResolvedValue(fakeUpdate("1.1.0") as never);
    await updater.check();
    expect(updater.phase()).toBe("available");
    expect(updater.update()?.version).toBe("1.1.0");
  });

  it("reports up to date when there is no update", async () => {
    vi.mocked(check).mockResolvedValue(null);
    await updater.check();
    expect(updater.phase()).toBe("up-to-date");
  });

  it("does not offer a pre-release to a stable install", async () => {
    vi.mocked(check).mockResolvedValue(fakeUpdate("1.1.0-rc1") as never);
    await updater.check();
    expect(updater.phase()).toBe("up-to-date");
    expect(updater.update()).toBeNull();
  });

  it("names the failed check step", async () => {
    vi.mocked(check).mockRejectedValue(new Error("offline"));
    await updater.check();
    expect(updater.phase()).toBe("error");
    expect(updater.failedStep()).toBe("check");
    expect(updater.error()).toBe("Check for updates failed: offline");
  });

  it("saves the editor, installs and restarts", async () => {
    const order: string[] = [];
    editor.handle!.flush.mockImplementation(async () => void order.push("flush"));
    const download = vi.fn(async (onEvent: (e: unknown) => void) => {
      order.push("download");
      onEvent({ event: "Started", data: { contentLength: 200 } });
      onEvent({ event: "Progress", data: { chunkLength: 50 } });
      expect(updater.percent()).toBe(25);
    });
    vi.mocked(relaunch).mockImplementation(async () => void order.push("relaunch"));
    vi.mocked(check).mockResolvedValue(fakeUpdate("1.1.0", download) as never);
    await updater.check();
    await updater.install();
    expect(order).toEqual(["flush", "download", "relaunch"]);
  });

  it("keeps the update available after a failed install and retries", async () => {
    const download = vi.fn().mockRejectedValueOnce(new Error("signature")).mockResolvedValueOnce(undefined);
    vi.mocked(check).mockResolvedValue(fakeUpdate("1.1.0", download) as never);
    await updater.check();
    await updater.install();
    expect(updater.phase()).toBe("error");
    expect(updater.failedStep()).toBe("update");
    expect(updater.error()).toBe("Update failed: signature");
    expect(updater.update()?.version).toBe("1.1.0");
    expect(relaunch).not.toHaveBeenCalled();
    await updater.install();
    expect(download).toHaveBeenCalledTimes(2);
    expect(relaunch).toHaveBeenCalled();
  });

  it("does not restart when saving the editor fails", async () => {
    editor.handle!.flush.mockRejectedValue(new Error("disk full"));
    const download = vi.fn();
    vi.mocked(check).mockResolvedValue(fakeUpdate("1.1.0", download) as never);
    await updater.check();
    await updater.install();
    expect(download).not.toHaveBeenCalled();
    expect(updater.error()).toBe("Update failed: disk full");
  });

  it("does not install while the note is still unsaved", async () => {
    editor.handle!.dirty.mockReturnValue(true);
    const download = vi.fn();
    vi.mocked(check).mockResolvedValue(fakeUpdate("1.1.0", download) as never);
    await updater.check();
    await updater.install();
    expect(download).not.toHaveBeenCalled();
    expect(updater.error()).toBe("Update failed: the open note could not be saved");
    expect(updater.update()?.version).toBe("1.1.0");
  });
});

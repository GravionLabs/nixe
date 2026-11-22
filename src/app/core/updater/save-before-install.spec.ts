// @vitest-environment jsdom
import "@angular/compiler";
import { TestBed } from "@angular/core/testing";
import { BrowserTestingModule, platformBrowserTesting } from "@angular/platform-browser/testing";
import {
  HX_UPDATE_BACKEND,
  HX_UPDATE_BEFORE_INSTALL,
  HxUpdateService,
  provideHxAppInfo,
} from "@gravionlabs/helix-desktop/tauri";
import type { HxUpdateBackend } from "@gravionlabs/helix-desktop/tauri";
import type { Mock } from "vitest";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

import { EditorService } from "../editor/editor.service";
import { saveBeforeInstall } from "./save-before-install";

const found = { version: "1.3.0", notes: null, date: null };

describe("the update install with the open note", () => {
  let dirty: boolean;
  let flush: Mock<() => Promise<void>>;
  let backend: { [K in keyof HxUpdateBackend]: ReturnType<typeof vi.fn> };

  beforeAll(() => {
    TestBed.initTestEnvironment(BrowserTestingModule, platformBrowserTesting());
  });

  beforeEach(() => {
    dirty = false;
    flush = vi.fn(() => Promise.resolve());
    backend = {
      check: vi.fn(async () => found),
      install: vi.fn(async () => {}),
      relaunch: vi.fn(async () => {}),
    };
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        provideHxAppInfo({ version: "1.2.0" }),
        { provide: HX_UPDATE_BACKEND, useValue: backend },
        { provide: EditorService, useValue: { handle: { flush, dirty: () => dirty } } },
        { provide: HX_UPDATE_BEFORE_INSTALL, useFactory: saveBeforeInstall },
      ],
    });
  });

  it("saves the open note before the install and restarts", async () => {
    const service = TestBed.inject(HxUpdateService);
    await service.check();
    await service.installAndRestart();
    expect(flush).toHaveBeenCalledOnce();
    expect(backend.install).toHaveBeenCalledOnce();
    expect(backend.relaunch).toHaveBeenCalledOnce();
  });

  it("flushes a dirty note that then saves", async () => {
    dirty = true;
    flush.mockImplementation(() => {
      dirty = false;
      return Promise.resolve();
    });
    const service = TestBed.inject(HxUpdateService);
    await service.check();
    await service.installAndRestart();
    expect(backend.install).toHaveBeenCalledOnce();
  });

  it("refuses the install when the note could not be saved, and a retry installs", async () => {
    dirty = true;
    const service = TestBed.inject(HxUpdateService);
    await service.check();
    await service.installAndRestart();
    expect(backend.install).not.toHaveBeenCalled();
    expect(service.state()).toMatchObject({ status: "error", step: "install" });

    dirty = false;
    await service.installAndRestart();
    expect(backend.install).toHaveBeenCalledOnce();
    expect(backend.relaunch).toHaveBeenCalledOnce();
  });

  it("retries after a failed install", async () => {
    backend.install.mockRejectedValueOnce(new Error("disk full"));
    const service = TestBed.inject(HxUpdateService);
    await service.check();
    await service.installAndRestart();
    expect(service.state()).toMatchObject({ status: "error", step: "install" });
    await service.installAndRestart();
    expect(backend.relaunch).toHaveBeenCalledOnce();
  });

  it("a manual check shows Up to date and then goes idle", async () => {
    vi.useFakeTimers();
    try {
      backend.check.mockResolvedValue(null);
      const service = TestBed.inject(HxUpdateService);
      await service.check({ manual: true });
      expect(service.state().status).toBe("current");
      expect(service.currentShown()).toBe(true);
      await vi.advanceTimersByTimeAsync(3100);
      expect(service.state().status).toBe("idle");
    } finally {
      vi.useRealTimers();
    }
  });
});

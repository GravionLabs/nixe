// @vitest-environment jsdom
import "@angular/compiler";
import { signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { BrowserTestingModule, platformBrowserTesting } from "@angular/platform-browser/testing";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { backend } from "../file/backend";
import { SettingsService } from "../settings/settings.service";
import { CaptureShortcutService } from "./capture-shortcut.service";

describe("CaptureShortcutService", () => {
  const shortcut = signal("");
  const flush = vi.fn(() => Promise.resolve());

  beforeAll(() => {
    TestBed.initTestEnvironment(BrowserTestingModule, platformBrowserTesting());
  });

  beforeEach(() => {
    vi.restoreAllMocks();
    shortcut.set("");
    flush.mockClear();
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [{ provide: SettingsService, useValue: { captureShortcut: shortcut, flush } }],
    });
  });

  it("does not register at startup, the backend does that", () => {
    const apply = vi.spyOn(backend, "captureApply").mockResolvedValue(undefined);
    TestBed.inject(CaptureShortcutService);
    TestBed.tick();
    expect(apply).not.toHaveBeenCalled();
  });

  it("registers again after the settings were written when the shortcut changes", async () => {
    const apply = vi.spyOn(backend, "captureApply").mockResolvedValue(undefined);
    const service = TestBed.inject(CaptureShortcutService);
    TestBed.tick();
    shortcut.set("Alt+Space");
    TestBed.tick();
    await vi.waitFor(() => expect(apply).toHaveBeenCalledTimes(1));
    expect(flush).toHaveBeenCalled();
    expect(service.error()).toBeNull();
  });

  it("reports an invalid shortcut", async () => {
    vi.spyOn(backend, "captureApply").mockRejectedValue("bad: invalid");
    const service = TestBed.inject(CaptureShortcutService);
    TestBed.tick();
    shortcut.set("bad");
    TestBed.tick();
    await vi.waitFor(() => expect(service.error()).toBe("bad: invalid"));
  });
});

// @vitest-environment jsdom
import "@angular/compiler";
import { signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { BrowserTestingModule, platformBrowserTesting } from "@angular/platform-browser/testing";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

import type { HealthReport } from "../file/backend";
import { backend } from "../file/backend";
import { SettingsService } from "../settings/settings.service";
import { HealthService } from "./health.service";
import { IndexService } from "./index.service";

const empty: HealthReport = { brokenLinks: [], orphans: [], duplicates: [], unusedAttachments: [] };

describe("HealthService", () => {
  const status = signal<{ state: string }>({ state: "ready" });
  const exclude = signal<string[]>([]);
  let health: HealthService;

  beforeAll(() => {
    TestBed.initTestEnvironment(BrowserTestingModule, platformBrowserTesting());
  });

  beforeEach(() => {
    status.set({ state: "ready" });
    exclude.set([]);
    vi.restoreAllMocks();
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        { provide: IndexService, useValue: { status, revision: signal(0) } },
        { provide: SettingsService, useValue: { healthExclude: exclude } },
      ],
    });
    health = TestBed.inject(HealthService);
  });

  it("reads the report with the excluded folders", async () => {
    exclude.set(["templates"]);
    const spy = vi.spyOn(backend, "vaultHealth").mockResolvedValue(empty);
    await health.refresh();
    expect(spy).toHaveBeenCalledWith(["templates"]);
    expect(health.report()).toEqual(empty);
    expect(health.state()).toBe("ready");
  });

  it("parses the excluded folders from a list", () => {
    health.setExcluded(" templates/, ./archive ,,templates\nDaily/Old");
    expect(exclude()).toEqual(["templates", "archive", "Daily/Old"]);
  });

  it("reads the report again when the folders change", () => {
    const before = health.key();
    health.setExcluded("archive");
    expect(health.key()).not.toBe(before);
  });

  it("waits for the index and reports a failure", async () => {
    status.set({ state: "scanning" });
    const spy = vi.spyOn(backend, "vaultHealth").mockRejectedValue(new Error("x"));
    await health.refresh();
    expect(spy).not.toHaveBeenCalled();
    expect(health.state()).toBe("loading");
    status.set({ state: "ready" });
    await health.refresh();
    expect(health.state()).toBe("error");
  });

  it("the newest request wins", async () => {
    let first!: (r: HealthReport) => void;
    const slow = { ...empty, orphans: [{ path: "old.md", title: "old" }] };
    vi.spyOn(backend, "vaultHealth")
      .mockImplementationOnce(() => new Promise((r) => (first = r)))
      .mockResolvedValueOnce(empty);
    const a = health.refresh();
    await health.refresh();
    first(slow);
    await a;
    expect(health.report()).toEqual(empty);
  });
});

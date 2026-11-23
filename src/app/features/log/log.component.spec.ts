// @vitest-environment jsdom
import "@angular/compiler";
import { readFileSync } from "node:fs";
import { TestBed } from "@angular/core/testing";
import { BrowserTestingModule, platformBrowserTesting } from "@angular/platform-browser/testing";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/plugin-opener", () => ({ revealItemInDir: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

import { LogComponent } from "./log.component";

async function render(): Promise<HTMLElement> {
  TestBed.overrideComponent(LogComponent, {
    set: {
      templateUrl: undefined,
      styleUrl: undefined,
      template: readFileSync("src/app/features/log/log.component.html", "utf8"),
    },
  });
  const fixture = TestBed.createComponent(LogComponent);
  await fixture.whenStable();
  fixture.detectChanges();
  return fixture.nativeElement as HTMLElement;
}

describe("LogComponent", () => {
  beforeAll(() => TestBed.initTestEnvironment(BrowserTestingModule, platformBrowserTesting()));
  beforeEach(() => {
    window.matchMedia ??= (() => ({ matches: false, addEventListener: vi.fn() })) as never;
    invoke.mockReset();
    TestBed.resetTestingModule();
  });

  it("shows the whole log as read-only text, newest line last", async () => {
    invoke.mockResolvedValue("INFO first\nERROR last\n");
    const el = await render();
    expect(invoke).toHaveBeenCalledWith("log_read", { lines: null });
    const text = el.querySelector("pre.text")!;
    expect(text.textContent).toBe("INFO first\nERROR last\n");
    expect(el.querySelector("textarea, input")).toBeNull();
  });

  it("says when the log is empty or cannot be read", async () => {
    invoke.mockResolvedValue("");
    expect((await render()).querySelector(".status")?.textContent).toContain("empty");
    TestBed.resetTestingModule();
    invoke.mockRejectedValue("no log");
    expect((await render()).querySelector('[role="alert"]')?.textContent).toContain(
      "not available",
    );
  });
});

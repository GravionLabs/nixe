// @vitest-environment jsdom
import "@angular/compiler";
import { readFileSync } from "node:fs";
import { TestBed } from "@angular/core/testing";
import { BrowserTestingModule, platformBrowserTesting } from "@angular/platform-browser/testing";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => undefined)) }));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({
  readText: vi.fn(() => Promise.resolve("https://example.com")),
}));

import { CaptureService } from "../../core/capture/capture.service";
import { backend } from "../../core/file/backend";
import { CaptureComponent } from "./capture.component";

describe("CaptureComponent", () => {
  beforeAll(() => {
    TestBed.initTestEnvironment(BrowserTestingModule, platformBrowserTesting());
  });

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(backend, "captureNoteNames").mockResolvedValue(["Project plan"]);
    vi.spyOn(backend, "captureHide").mockResolvedValue(undefined);
    TestBed.resetTestingModule();
  });

  function create() {
    TestBed.overrideComponent(CaptureComponent, {
      set: {
        templateUrl: undefined,
        styleUrl: undefined,
        template: readFileSync("src/app/features/capture/capture.component.html", "utf8"),
      },
    });
    const fixture = TestBed.createComponent(CaptureComponent);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    const area = el.querySelector("textarea")!;
    const type = (value: string) => {
      area.value = value;
      area.setSelectionRange(value.length, value.length);
      area.dispatchEvent(new Event("input"));
      fixture.detectChanges();
    };
    const key = (init: KeyboardEventInit) => {
      const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
      area.dispatchEvent(event);
      fixture.detectChanges();
      return event;
    };
    return { fixture, el, area, type, key };
  }

  it("saves with Enter and discards with Escape", async () => {
    const save = vi.spyOn(backend, "captureSave").mockResolvedValue("/v/n.md");
    const { type, key, fixture } = create();
    type("hello");
    key({ key: "Enter" });
    await fixture.whenStable();
    expect(save).toHaveBeenCalledWith("hello");
    expect(backend.captureHide).toHaveBeenCalledTimes(1);

    type("dropped");
    key({ key: "Escape" });
    await fixture.whenStable();
    expect(save).toHaveBeenCalledTimes(1);
    expect(backend.captureHide).toHaveBeenCalledTimes(2);
  });

  it("keeps a new line on Shift+Enter", () => {
    const save = vi.spyOn(backend, "captureSave");
    const { type, key } = create();
    type("a");
    expect(key({ key: "Enter", shiftKey: true }).defaultPrevented).toBe(false);
    expect(save).not.toHaveBeenCalled();
  });

  it("offers note names after [[ and completes with Enter instead of saving", async () => {
    const save = vi.spyOn(backend, "captureSave");
    const { type, key, el, fixture } = create();
    await fixture.whenStable();
    type("see [[pro");
    expect(el.querySelectorAll("li[role=option]").length).toBe(1);
    key({ key: "Enter" });
    expect(TestBed.inject(CaptureService).text()).toBe("see [[Project plan]]");
    expect(save).not.toHaveBeenCalled();
    expect(el.querySelector("ul")).toBeNull();
  });

  it("inserts the clipboard with one key and shows a failed save", async () => {
    vi.spyOn(backend, "captureLinkTitle").mockResolvedValue("Example");
    vi.spyOn(backend, "captureSave").mockRejectedValue("no vault");
    const { key, fixture, el } = create();
    key({ key: "V", ctrlKey: true, shiftKey: true });
    await vi.waitFor(() =>
      expect(TestBed.inject(CaptureService).text()).toBe("[Example](https://example.com)"),
    );
    key({ key: "Enter" });
    await fixture.whenStable();
    fixture.detectChanges();
    expect(el.querySelector("[role=alert]")?.textContent).toContain("no vault");
  });
});

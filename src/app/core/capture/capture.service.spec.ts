// @vitest-environment jsdom
import "@angular/compiler";
import { TestBed } from "@angular/core/testing";
import { BrowserTestingModule, platformBrowserTesting } from "@angular/platform-browser/testing";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { backend } from "../file/backend";
import { CaptureService } from "./capture.service";

describe("CaptureService", () => {
  let capture: CaptureService;

  beforeAll(() => {
    TestBed.initTestEnvironment(BrowserTestingModule, platformBrowserTesting());
  });

  beforeEach(async () => {
    vi.restoreAllMocks();
    vi.spyOn(backend, "captureNoteNames").mockResolvedValue(["Project plan", "Zebra"]);
    vi.spyOn(backend, "captureHide").mockResolvedValue(undefined);
    TestBed.resetTestingModule();
    capture = TestBed.inject(CaptureService);
    await capture.reset();
  });

  it("saves the text, hides the window and starts empty", async () => {
    const save = vi.spyOn(backend, "captureSave").mockResolvedValue("/v/n.md");
    capture.edit("hello", 5);
    expect(await capture.save()).toBe(true);
    expect(save).toHaveBeenCalledWith("hello");
    expect(backend.captureHide).toHaveBeenCalled();
    expect(capture.text()).toBe("");
  });

  it("does not save an empty capture", async () => {
    const save = vi.spyOn(backend, "captureSave");
    capture.edit("  \n", 3);
    expect(await capture.save()).toBe(false);
    expect(save).not.toHaveBeenCalled();
  });

  it("keeps the text and shows the error when saving fails", async () => {
    vi.spyOn(backend, "captureSave").mockRejectedValue("no vault");
    capture.edit("hello", 5);
    expect(await capture.save()).toBe(false);
    expect(capture.error()).toBe("no vault");
    expect(capture.text()).toBe("hello");
    expect(backend.captureHide).not.toHaveBeenCalled();
    expect(capture.busy()).toBe(false);
  });

  it("discards without saving", async () => {
    const save = vi.spyOn(backend, "captureSave");
    capture.edit("hello", 5);
    await capture.discard();
    expect(save).not.toHaveBeenCalled();
    expect(backend.captureHide).toHaveBeenCalled();
    expect(capture.text()).toBe("");
  });

  it("completes a [[ with the selected note", () => {
    capture.edit("see [[pr", 8);
    expect(capture.suggestions()).toEqual(["Project plan"]);
    expect(capture.complete()).toBe(true);
    expect(capture.text()).toBe("see [[Project plan]]");
    expect(capture.pendingCaret()).toBe(20);
    expect(capture.suggestions()).toEqual([]);
  });

  it("moves through the suggestions and wraps around", () => {
    capture.edit("[[", 2);
    expect(capture.suggestions()).toEqual(["Project plan", "Zebra"]);
    capture.moveSelection(1);
    expect(capture.complete()).toBe(true);
    expect(capture.text()).toBe("[[Zebra]]");
    capture.edit("[[", 2);
    capture.moveSelection(-1);
    expect(capture.selected()).toBe(1);
  });

  it("does not complete outside a link", () => {
    capture.edit("plain", 5);
    expect(capture.complete()).toBe(false);
  });

  it("turns a copied URL into a link with the page title", async () => {
    vi.spyOn(backend, "captureLinkTitle").mockResolvedValue("Example Domain");
    capture.edit("see : end", 6);
    await capture.insertClipboard(() => Promise.resolve("https://example.com"), 4, 5);
    expect(capture.text()).toBe("see [Example Domain](https://example.com) end");
  });

  it("inserts the bare URL when the title is not available", async () => {
    vi.spyOn(backend, "captureLinkTitle").mockResolvedValue(null);
    await capture.insertClipboard(() => Promise.resolve("https://example.com"), 0, 0);
    expect(capture.text()).toBe("https://example.com");
    vi.spyOn(backend, "captureLinkTitle").mockRejectedValue("x");
    await capture.insertClipboard(() => Promise.resolve("https://example.org"), 19, 19);
    expect(capture.text()).toBe("https://example.comhttps://example.org");
  });

  it("inserts other clipboard text as it is and ignores an empty or unreadable clipboard", async () => {
    const title = vi.spyOn(backend, "captureLinkTitle");
    await capture.insertClipboard(() => Promise.resolve("two words"), 0, 0);
    expect(capture.text()).toBe("two words");
    expect(title).not.toHaveBeenCalled();
    await capture.insertClipboard(() => Promise.resolve(null), 0, 0);
    await capture.insertClipboard(() => Promise.reject(new Error("denied")), 0, 0);
    expect(capture.text()).toBe("two words");
  });
});

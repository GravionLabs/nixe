// @vitest-environment jsdom
import "@angular/compiler";
import { TestBed } from "@angular/core/testing";
import { BrowserTestingModule, platformBrowserTesting } from "@angular/platform-browser/testing";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { backend } from "../file/backend";
import { SPIKE_URL, WebViewService } from "./web-view.service";

const area = (x: number, y: number, width: number, height: number) =>
  ({ getBoundingClientRect: () => ({ x, y, width, height }) }) as unknown as Element;

describe("WebViewService", () => {
  let service: WebViewService;

  beforeAll(() => {
    TestBed.initTestEnvironment(BrowserTestingModule, platformBrowserTesting());
  });

  beforeEach(() => {
    TestBed.resetTestingModule();
    vi.spyOn(backend, "webViewOpen").mockResolvedValue();
    vi.spyOn(backend, "webViewSetBounds").mockResolvedValue();
    vi.spyOn(backend, "webViewSetVisible").mockResolvedValue();
    vi.spyOn(backend, "webViewClose").mockResolvedValue();
    service = TestBed.inject(WebViewService);
  });

  afterEach(() => vi.restoreAllMocks());

  it("opens the spike page over the area", async () => {
    await service.open(area(1, 2, 300, 200));

    expect(backend.webViewOpen).toHaveBeenCalledWith("spike", SPIKE_URL, {
      x: 1,
      y: 2,
      width: 300,
      height: 200,
    });
    expect(service.status()).toBe("shown");
  });

  it("stays closed when the page cannot be opened", async () => {
    vi.mocked(backend.webViewOpen).mockRejectedValue("no main window");

    await expect(service.open(area(0, 0, 1, 1))).rejects.toBe("no main window");
    expect(service.status()).toBe("closed");
  });

  it("hides, shows again and moves an open page", async () => {
    await service.open(area(0, 0, 10, 10));
    await service.toggle();
    expect(service.status()).toBe("hidden");

    await service.open(area(5, 5, 20, 20));

    expect(backend.webViewOpen).toHaveBeenCalledTimes(1);
    expect(backend.webViewSetBounds).toHaveBeenCalledWith("spike", {
      x: 5,
      y: 5,
      width: 20,
      height: 20,
    });
    expect(backend.webViewSetVisible).toHaveBeenLastCalledWith("spike", true);
    expect(service.status()).toBe("shown");
  });

  it("closes the page and calls nothing without one", async () => {
    await service.moveTo(area(0, 0, 1, 1));
    await service.toggle();
    await service.close();
    expect(backend.webViewSetBounds).not.toHaveBeenCalled();
    expect(backend.webViewSetVisible).not.toHaveBeenCalled();
    expect(backend.webViewClose).not.toHaveBeenCalled();

    await service.open(area(0, 0, 1, 1));
    await service.close();

    expect(backend.webViewClose).toHaveBeenCalledWith("spike");
    expect(service.status()).toBe("closed");
  });
});

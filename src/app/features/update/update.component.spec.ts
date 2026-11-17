// @vitest-environment jsdom
import "@angular/compiler";
import { readFileSync } from "node:fs";
import { signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { BrowserTestingModule, platformBrowserTesting } from "@angular/platform-browser/testing";
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: vi.fn() }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: vi.fn() }));
vi.mock("@tauri-apps/plugin-updater", () => ({ check: vi.fn(), Update: class {} }));

import { UpdateService } from "../../core/updater/update.service";
import { UpdateComponent } from "./update.component";

function render(phase: string, update: { version: string; body: string } | null, error = "") {
  const updater = {
    phase: signal(phase),
    update: signal(update),
    error: signal(error),
    version: signal("1.0.0"),
    percent: signal<number | null>(null),
    install: vi.fn(),
    check: vi.fn(),
    close: vi.fn(),
  };
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({ providers: [{ provide: UpdateService, useValue: updater }] });
  TestBed.overrideComponent(UpdateComponent, {
    set: { templateUrl: undefined, styleUrl: undefined, template: readFileSync("src/app/features/update/update.component.html", "utf8") },
  });
  const fixture = TestBed.createComponent(UpdateComponent);
  fixture.detectChanges();
  return { updater, el: fixture.nativeElement as HTMLElement };
}

const button = (el: HTMLElement, text: string) => [...el.querySelectorAll("button")].find((b) => b.textContent?.includes(text));

describe("UpdateComponent", () => {
  beforeAll(() => {
    TestBed.initTestEnvironment(BrowserTestingModule, platformBrowserTesting());
  });

  it("shows the release notes and installs on click", () => {
    const { updater, el } = render("available", { version: "1.1.0", body: "Fixes" });
    expect(el.querySelector(".notes")?.textContent).toBe("Fixes");
    button(el, "Install and restart")!.click();
    expect(updater.install).toHaveBeenCalled();
  });

  it("shows the error and offers a retry that keeps the update", () => {
    const { updater, el } = render("error", { version: "1.1.0", body: "" }, "Update failed: signature");
    expect(el.querySelector("[role=alert]")?.textContent).toContain("Update failed");
    button(el, "Retry")!.click();
    expect(updater.install).toHaveBeenCalled();
  });

  it("retries a failed check", () => {
    const { updater, el } = render("error", null, "Check for updates failed: offline");
    button(el, "Retry")!.click();
    expect(updater.check).toHaveBeenCalled();
  });

  it("says when the app is up to date", () => {
    const { el } = render("up-to-date", null);
    expect(el.textContent).toContain("is up to date");
  });
});

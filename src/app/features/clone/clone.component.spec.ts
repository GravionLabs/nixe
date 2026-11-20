// @vitest-environment jsdom
import "@angular/compiler";
import { readFileSync } from "node:fs";
import { signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { BrowserTestingModule, platformBrowserTesting } from "@angular/platform-browser/testing";
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

import { CloneService } from "../../core/git/clone.service";
import { GitService } from "../../core/git/git.service";
import { CloneComponent } from "./clone.component";

function render(prompt: { reason: "required" | "failed" } | null = null, cloning = false) {
  const clone = {
    visible: signal(true),
    url: signal("https://github.com/a/b"),
    parent: signal(""),
    cloning: signal(cloning),
    error: signal(""),
    percent: signal<number | null>(cloning ? 40 : null),
    canStart: signal(true),
    start: vi.fn(),
    close: vi.fn(),
    chooseFolder: vi.fn().mockResolvedValue(undefined),
  };
  const git = { tokenPrompt: signal(prompt), saveToken: vi.fn().mockResolvedValue(undefined) };
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      { provide: CloneService, useValue: clone },
      { provide: GitService, useValue: git },
    ],
  });
  TestBed.overrideComponent(CloneComponent, {
    set: { templateUrl: undefined, styleUrl: undefined, template: readFileSync("src/app/features/clone/clone.component.html", "utf8") },
  });
  const fixture = TestBed.createComponent(CloneComponent);
  fixture.detectChanges();
  // hx-dialog renders its content in the overlay, outside the host element.
  return { clone, git, el: document.body, fixture };
}

describe("CloneComponent", () => {
  beforeAll(() => {
    TestBed.initTestEnvironment(BrowserTestingModule, platformBrowserTesting());
  });

  it("starts the clone on submit and closes on the mask", async () => {
    const { clone, el, fixture } = render();
    expect(el.querySelector("[role=dialog]")?.textContent).toContain("Clone vault");
    el.querySelector("form")!.dispatchEvent(new Event("submit", { cancelable: true }));
    expect(clone.start).toHaveBeenCalled();
    (el.querySelector(".hx-dialog-backdrop") as HTMLElement).click();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(clone.close).toHaveBeenCalled();
    });
  });

  it("shows the progress and a cancel button while cloning", () => {
    const { el } = render(null, true);
    expect(el.textContent).toContain("Cloning… 40%");
    expect(el.querySelector("progress")?.value).toBe(40);
    expect(el.textContent).toContain("Cancel clone");
  });

  it("chooses the target folder", () => {
    const { clone, el } = render();
    expect(el.textContent).toContain("No target folder chosen");
    (el.querySelector(".folder button") as HTMLElement).click();
    expect(clone.chooseFolder).toHaveBeenCalled();
  });

  it("reuses the token prompt of the Git service", () => {
    const { git, el } = render({ reason: "failed" });
    expect(el.querySelector("[role=alert]")?.textContent).toContain("rejected");
    const input = el.querySelector("input[type=password]") as HTMLInputElement;
    input.value = "tok";
    (el.querySelector(".token button") as HTMLElement).click();
    expect(git.saveToken).toHaveBeenCalledWith("tok");
  });

  it("has no token field without a prompt", () => {
    const { el } = render();
    expect(el.querySelector("input[type=password]")).toBeNull();
  });
});

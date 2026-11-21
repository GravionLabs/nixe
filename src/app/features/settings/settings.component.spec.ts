// @vitest-environment jsdom
import "@angular/compiler";
import { readFileSync } from "node:fs";
import { signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { BrowserTestingModule, platformBrowserTesting } from "@angular/platform-browser/testing";
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { CommandRegistry } from "../../core/commands/command-registry";
import { ShortcutService } from "../../core/commands/shortcut.service";
import type { SettingItem } from "../../core/settings/settings-registry";
import { SettingsPageService } from "../../core/settings/settings-page.service";
import { SettingsComponent } from "./settings.component";

function render(opts: { stored?: boolean; prompt?: "required" | "failed" | null } = {}) {
  const save = vi.fn().mockResolvedValue(undefined);
  const remove = vi.fn().mockResolvedValue(undefined);
  const cancelPrompt = vi.fn();
  const item: SettingItem = {
    kind: "token",
    id: "git-token",
    label: "Access token",
    stored: () => opts.stored ?? false,
    prompt: () => opts.prompt ?? null,
    save,
    remove,
    cancelPrompt,
  };
  const page = {
    sections: signal([{ id: "sync", title: "Sync", items: [item] }]),
    listed: signal([{ id: "sync", title: "Sync", items: [item] }]),
    query: signal(""),
    selectedId: signal("sync"),
    select: vi.fn(),
    refreshObsidian: vi.fn().mockResolvedValue(undefined),
  };
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      { provide: SettingsPageService, useValue: page },
      { provide: ShortcutService, useValue: { cancel: vi.fn() } },
      { provide: CommandRegistry, useValue: { get: vi.fn() } },
    ],
  });
  TestBed.overrideComponent(SettingsComponent, {
    set: {
      templateUrl: undefined,
      styleUrl: undefined,
      template: readFileSync("src/app/features/settings/settings.component.html", "utf8"),
    },
  });
  const fixture = TestBed.createComponent(SettingsComponent);
  fixture.detectChanges();
  return { fixture, el: fixture.nativeElement as HTMLElement, save, remove, cancelPrompt };
}

const button = (el: HTMLElement, text: string) =>
  [...el.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === text);

describe("SettingsComponent token entry", () => {
  beforeAll(() => TestBed.initTestEnvironment(BrowserTestingModule, platformBrowserTesting()));

  it("offers to save a token when none is stored", () => {
    const { el } = render();
    expect(el.textContent).toContain("No token stored");
    expect(button(el, "Save token")).toBeTruthy();
    expect(button(el, "Delete token")).toBeUndefined();
  });

  it("replaces and deletes a stored token without showing it", async () => {
    const { el, save, remove, fixture } = render({ stored: true });
    expect(el.textContent).toContain("A token is stored");
    const input = el.querySelector<HTMLInputElement>("input[type=password]")!;
    input.value = "ghp_secret";
    button(el, "Replace token")!.click();
    await fixture.whenStable();
    expect(save).toHaveBeenCalledWith("ghp_secret");
    expect(input.value).toBe("");
    button(el, "Delete token")!.click();
    expect(remove).toHaveBeenCalled();
  });

  it("shows the token prompt of a running sync and lets it be cancelled", () => {
    const { el, cancelPrompt } = render({ prompt: "failed" });
    expect(el.querySelector("[role=alert]")!.textContent).toContain("rejected the token");
    button(el, "Cancel")!.click();
    expect(cancelPrompt).toHaveBeenCalled();
    expect(render({ prompt: "required" }).el.textContent).toContain(
      "Enter a personal access token",
    );
  });

  it("reports a failed save next to the field", async () => {
    const { el, save, fixture } = render();
    save.mockRejectedValue("keychain locked");
    button(el, "Save token")!.click();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(el.textContent).toContain("keychain locked");
  });
});

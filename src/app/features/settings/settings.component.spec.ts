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

function render(
  opts: {
    stored?: boolean;
    prompt?: "required" | "failed" | null;
    gh?: { notice?: string; error?: string; busy?: boolean };
  } = {},
) {
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
    gh: opts.gh && {
      available: () => true,
      code: () => null,
      busy: () => opts.gh!.busy ?? false,
      error: () => opts.gh!.error ?? "",
      notice: () => opts.gh!.notice ?? "",
      hosts: () => ["github.com"],
      signIn: vi.fn().mockResolvedValue(undefined),
      cancel: vi.fn().mockResolvedValue(undefined),
    },
  };
  const page = {
    sections: signal([{ id: "sync", title: "Sync", items: [item] }]),
    listed: signal([{ id: "sync", title: "Sync", items: [item] }]),
    query: signal(""),
    selectedId: signal("sync"),
    select: vi.fn(),
    refreshObsidian: vi.fn().mockResolvedValue(undefined),
    loadLocations: vi.fn().mockResolvedValue(undefined),
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
    expect(el.textContent).toContain("Token stored in the system keychain");
    expect(el.querySelector("input[type=password]")).toBeNull();
    button(el, "Replace")!.click();
    fixture.detectChanges();
    const input = el.querySelector<HTMLInputElement>("input[type=password]")!;
    input.value = "ghp_secret";
    button(el, "Replace token")!.click();
    await fixture.whenStable();
    expect(save).toHaveBeenCalledWith("ghp_secret");
    expect(input.value).toBe("");
    fixture.detectChanges();
    expect(el.querySelector("input[type=password]")).toBeNull();
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

describe("SettingsComponent token layout", () => {
  it("puts the state first, the sign-in button next and the token field last behind a fallback", () => {
    const { el, fixture } = render({ gh: {} });
    const text = el.querySelector(".token")!.textContent!;
    expect(text.indexOf("No token stored")).toBeLessThan(text.indexOf("Sign in with GitHub (gh)"));
    expect(button(el, "Sign in with GitHub (gh)")!.classList.contains("primary")).toBe(true);
    expect(el.querySelector("input[type=password]")).toBeNull();
    button(el, "Use a personal access token instead")!.click();
    fixture.detectChanges();
    expect(el.querySelector(".token-manual input[type=password]")).toBeTruthy();
    expect(button(el, "Use a personal access token instead")).toBeUndefined();
  });

  it("keeps every part of the setting inside one column", () => {
    const css = readFileSync("src/app/features/settings/settings.component.css", "utf8");
    expect(css).toMatch(/\.token \{[^}]*max-width: 320px/);
    expect(css).toMatch(/\.token > \* \{[^}]*max-width: 100%/);
    expect(css).toMatch(/\.token-manual input \{[^}]*min-width: 0/);
  });
});

describe("SettingsComponent gh sign-in result", () => {
  it("shows the notice of a finished sign-in", () => {
    const { el } = render({ stored: true, gh: { notice: "Signed in with the GitHub CLI: done." } });
    expect(el.querySelector("[role=status]")!.textContent).toContain(
      "Signed in with the GitHub CLI",
    );
    expect(el.querySelector("[role=alert]")).toBeNull();
  });

  it("shows the error of a failed sign-in and no notice", () => {
    const { el } = render({ gh: { error: "The GitHub CLI (gh) is not installed." } });
    expect(el.querySelector("[role=alert]")!.textContent).toContain("not installed");
    expect(el.querySelector("[role=status]")).toBeNull();
  });

  it("shows the busy notice while the sign-in runs", () => {
    expect(render({ gh: { busy: true } }).el.textContent).toContain("Waiting for the GitHub CLI");
  });
});

/** Lets the promises of a click settle. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve));

describe("SettingsComponent locations (#495)", () => {
  function renderLocations(variables: { name: string; path: string }[]) {
    const save = vi.fn().mockResolvedValue(undefined);
    const remove = vi.fn().mockResolvedValue(undefined);
    const item: SettingItem = {
      kind: "locations",
      id: "location-variables",
      label: "Location variables of this device",
      variables: () => variables,
      save,
      remove,
      reserved: ["Home"],
    };
    const section = { id: "locations", title: "Locations", items: [item] };
    const page = {
      sections: signal([section]),
      listed: signal([section]),
      query: signal(""),
      selectedId: signal("locations"),
      select: vi.fn(),
      refreshObsidian: vi.fn().mockResolvedValue(undefined),
      loadLocations: vi.fn().mockResolvedValue(undefined),
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
    const el = fixture.nativeElement as HTMLElement;
    const fill = (label: string, text: string) => {
      const input = el.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
      input.value = text;
      input.dispatchEvent(new Event("input"));
      // The app checks for changes after each key; the fixture does not.
      fixture.detectChanges();
    };
    return { fixture, el, save, remove, page, fill };
  }

  it("lists the variables with their folders and loads them when it opens", () => {
    const { el, page } = renderLocations([{ name: "Books", path: "D:\\Cloud\\Bücher" }]);
    expect(el.querySelector(".loc-name")!.textContent).toBe("$Books");
    expect(el.querySelector(".loc-path")!.textContent).toBe("D:\\Cloud\\Bücher");
    expect(page.loadLocations).toHaveBeenCalled();
    expect(renderLocations([]).el.textContent).toContain("No variable defined");
  });

  it("adds a variable and clears the form", async () => {
    const { el, fixture, save, fill } = renderLocations([]);
    fill("Variable name", "Books");
    fill("Folder", "/data/books");
    button(el, "Add")!.click();
    await settle();
    expect(save).toHaveBeenCalledWith("Books", "/data/books", null);
    fixture.detectChanges();
    expect(el.querySelector<HTMLInputElement>('input[aria-label="Folder"]')!.value).toBe("");
  });

  it("edits a row under its previous name and cancels an edit", async () => {
    const { el, fixture, save, fill } = renderLocations([{ name: "Books", path: "/b" }]);
    button(el, "Edit")!.click();
    fixture.detectChanges();
    expect(el.querySelector<HTMLInputElement>('input[aria-label="Variable name"]')!.value).toBe(
      "Books",
    );
    fill("Variable name", "Library");
    button(el, "Save")!.click();
    await settle();
    expect(save).toHaveBeenCalledWith("Library", "/b", "Books");
    button(el, "Edit")!.click();
    fixture.detectChanges();
    button(el, "Cancel")!.click();
    fixture.detectChanges();
    expect(button(el, "Add")).toBeTruthy();
  });

  it("removes a variable", () => {
    const { el, remove } = renderLocations([{ name: "Books", path: "/b" }]);
    button(el, "Remove")!.click();
    expect(remove).toHaveBeenCalledWith("Books");
  });

  it("shows why a variable is refused and keeps the form", async () => {
    const { el, fixture, save, fill } = renderLocations([]);
    save.mockRejectedValue("$Home is a built-in variable and cannot be redefined");
    fill("Variable name", "Home");
    fill("Folder", "/h");
    button(el, "Add")!.click();
    await settle();
    fixture.detectChanges();
    expect(el.querySelector("[role=alert]")!.textContent).toContain("built-in");
    expect(el.querySelector<HTMLInputElement>('input[aria-label="Folder"]')!.value).toBe("/h");
  });
});

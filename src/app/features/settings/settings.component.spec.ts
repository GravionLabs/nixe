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
    // The sign-in is the primary action: filled, not text or outlined.
    expect(
      button(el, "Sign in with GitHub (gh)")!.matches(".hx-button-text, .hx-button-outlined"),
    ).toBe(false);
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
    expect(css).toMatch(/\.token-manual > \.grow \{[^}]*min-width: 0/);
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

describe("SettingsComponent Helix controls (#690)", () => {
  const set = {
    toggle: vi.fn(),
    select: vi.fn(),
    text: vi.fn(),
    number: vi.fn(),
    action: vi.fn(),
  };

  function renderControls(recordingId: string | null = null) {
    const items: SettingItem[] = [
      {
        kind: "toggle",
        id: "wrap",
        label: "Wrap lines",
        description: "Long lines break.",
        get: () => true,
        set: set.toggle,
      },
      {
        kind: "select",
        id: "mode",
        label: "Mode",
        options: [
          { value: "", label: "None" },
          { value: "dark", label: "Dark" },
        ],
        get: () => "",
        set: set.select,
      },
      { kind: "text", id: "font", label: "Font", get: () => "Inter", set: set.text },
      {
        kind: "number",
        id: "size",
        label: "Size",
        min: 8,
        max: 32,
        get: () => 14,
        set: set.number,
      },
      { kind: "action", id: "run", label: "Import", buttonLabel: "Import now", run: set.action },
      { kind: "shortcut", id: "key", label: "Save note", commandId: "save" },
    ];
    const section = { id: "all", title: "All", items };
    const page = {
      sections: signal([section]),
      listed: signal([section]),
      query: signal(""),
      selectedId: signal("all"),
      select: vi.fn(),
      refreshObsidian: vi.fn().mockResolvedValue(undefined),
      loadLocations: vi.fn().mockResolvedValue(undefined),
    };
    const shortcuts = {
      cancel: vi.fn(),
      pending: () => null,
      recordingId: signal(recordingId),
      display: () => "Ctrl+S",
      isDefault: () => true,
      startRecording: vi.fn((id: string) => shortcuts.recordingId.set(id)),
    };
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        { provide: SettingsPageService, useValue: page },
        { provide: ShortcutService, useValue: shortcuts },
        { provide: CommandRegistry, useValue: { get: () => ({ id: "save" }) } },
      ],
    });
    TestBed.overrideComponent(SettingsComponent, { set: { styleUrl: undefined } });
    const fixture = TestBed.createComponent(SettingsComponent);
    document.body.append(fixture.nativeElement);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    return { fixture, el, shortcuts };
  }

  it("puts each setting in a field of its section, labelled and described", async () => {
    const { el, fixture } = renderControls();
    await fixture.whenStable();
    expect(el.querySelector("hx-fieldset legend")!.textContent!.trim()).toBe("All");
    expect(el.querySelectorAll("hx-fieldset hx-field")).toHaveLength(6);
    for (const id of ["wrap", "mode", "font", "size"]) {
      expect(el.querySelector(`label[for="setting-${id}"]`)).toBeTruthy();
    }
    const toggle = el.querySelector("#setting-wrap")!;
    expect(toggle.matches('input[type="checkbox"].hx-switch')).toBe(true);
    const hint = el.querySelector(`#${toggle.getAttribute("aria-describedby")}`);
    expect(hint!.textContent).toBe("Long lines break.");
    expect(el.querySelector("#setting-font")!.classList.contains("hx-input")).toBe(true);
    expect(el.querySelector("#setting-size")!.classList.contains("hx-input")).toBe(true);
    expect(el.querySelector("hx-select #setting-mode")!.textContent!.trim()).toBe("None");
    expect(el.querySelector("select")).toBeNull();
    fixture.nativeElement.remove();
  });

  it("applies a change of each control", () => {
    // jsdom has no scrolling; the open listbox scrolls to its active option.
    Element.prototype.scrollIntoView ??= () => undefined;
    const { el, fixture } = renderControls();
    const change = (selector: string, value: string) => {
      const input = el.querySelector<HTMLInputElement>(selector)!;
      input.value = value;
      input.dispatchEvent(new Event("change"));
    };
    el.querySelector<HTMLInputElement>("#setting-wrap")!.click();
    expect(set.toggle).toHaveBeenCalledWith(false);
    change("#setting-font", "Mono");
    expect(set.text).toHaveBeenCalledWith("Mono");
    change("#setting-size", "18");
    expect(set.number).toHaveBeenCalledWith(18);
    el.querySelector<HTMLButtonElement>("#setting-mode")!.click();
    fixture.detectChanges();
    const dark = [...document.querySelectorAll<HTMLElement>(".hx-select-option")].find(
      (o) => o.textContent!.trim() === "Dark",
    )!;
    dark.click();
    expect(set.select).toHaveBeenCalledWith("dark");
    button(el, "Import now")!.click();
    expect(set.action).toHaveBeenCalled();
    fixture.nativeElement.remove();
  });

  it("names a shortcut after its setting and starts the recording", () => {
    const { el, fixture, shortcuts } = renderControls();
    const chip = el.querySelector<HTMLButtonElement>("#setting-key")!;
    expect(chip.getAttribute("aria-label")).toBe("Save note: Ctrl+S");
    chip.click();
    expect(shortcuts.startRecording).toHaveBeenCalledWith("save");
    fixture.detectChanges();
    expect(el.querySelector("button.recording")).toBeTruthy();
    fixture.nativeElement.remove();
  });

  it("uses no raw control in the template (#690)", () => {
    const html = readFileSync("src/app/features/settings/settings.component.html", "utf8");
    const raw = [...html.matchAll(/<(button|input|select|textarea)\b((?:"[^"]*"|[^>"])*)>/g)]
      .filter((m) => !/\shx-(button|input|switch|checkbox)\b/.test(m[2]))
      .map((m) => m[0]);
    expect(raw).toEqual([]);
  });
});

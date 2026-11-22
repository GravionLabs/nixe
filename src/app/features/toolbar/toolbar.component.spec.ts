// @vitest-environment jsdom
import "@angular/compiler";
import { readFileSync } from "node:fs";
import { signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { By } from "@angular/platform-browser";
import { HxTooltip } from "@gravionlabs/helix-ui";
import { BrowserTestingModule, platformBrowserTesting } from "@angular/platform-browser/testing";
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

import { CommandRegistry } from "../../core/commands/command-registry";
import { EditorService } from "../../core/editor/editor.service";
import { DocumentService } from "../../core/file/document.service";
import { ShellService } from "../../core/shell/shell.service";
import { ShortcutService } from "../../core/commands/shortcut.service";
import { SettingsService } from "../../core/settings/settings.service";
import { VaultOpsService } from "../../core/workspace/vault-ops.service";
import { WorkspaceService } from "../../core/workspace/workspace.service";
import { ToolbarComponent } from "./toolbar.component";

function render(opts: {
  path: string | null;
  editing: boolean;
  blocked?: boolean;
  vault?: boolean;
  mode?: "live" | "source" | "reading";
}) {
  const execute = vi.fn().mockReturnValue(true);
  const back = vi.fn();
  const forward = vi.fn();
  const show = vi.fn();
  const reveal = vi.fn().mockResolvedValue(undefined);
  const rename = vi.fn().mockResolvedValue("/v/new.md");
  const editing = signal(opts.editing);
  const blocked = signal(opts.blocked ?? false);
  const mode = signal<"live" | "source" | "reading">(opts.mode ?? "live");
  const propertiesDisplay = signal<"visible" | "folded" | "hidden">("folded");
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      { provide: CommandRegistry, useValue: { execute } },
      {
        provide: ShortcutService,
        useValue: {
          keys: (id: string) => KEYS[id] ?? [],
          display: (id: string) => (KEYS[id] ?? []).join("+"),
        },
      },
      { provide: EditorService, useValue: { editing, blocked, mode } },
      {
        provide: DocumentService,
        useValue: {
          path: signal(opts.path),
          canGoBack: signal(false),
          canGoForward: signal(true),
          back,
          forward,
        },
      },
      {
        provide: WorkspaceService,
        useValue: { vaultRoot: signal(opts.vault === false ? null : "/v"), reveal },
      },
      { provide: ShellService, useValue: { show } },
      { provide: VaultOpsService, useValue: { rename } },
      {
        provide: SettingsService,
        useValue: {
          outlineVisible: signal(true),
          backlinksVisible: signal(false),
          propertiesDisplay,
        },
      },
    ],
  });
  TestBed.overrideComponent(ToolbarComponent, {
    set: {
      templateUrl: undefined,
      styleUrl: undefined,
      template: readFileSync("src/app/features/toolbar/toolbar.component.html", "utf8"),
    },
  });
  const fixture = TestBed.createComponent(ToolbarComponent);
  fixture.detectChanges();
  const el = fixture.nativeElement as HTMLElement;
  const modeButton = (label: string) =>
    [...el.querySelectorAll<HTMLButtonElement>(".seg button")].find(
      (b) => b.getAttribute("aria-label") === label,
    )!;
  return {
    fixture,
    modeButton,
    execute,
    editing,
    blocked,
    mode,
    propertiesDisplay,
    el,
    back,
    forward,
    show,
    reveal,
    rename,
  };
}

const KEYS: Record<string, string[]> = {
  "new-note": ["Ctrl", "N"],
  "new-folder": ["Ctrl", "Shift", "N"],
  "toggle-editor": ["Ctrl", "E"],
  "toggle-reading": ["Ctrl", "Alt", "E"],
};

describe("ToolbarComponent view mode", () => {
  beforeAll(() => {
    TestBed.initTestEnvironment(BrowserTestingModule, platformBrowserTesting());
  });

  it("offers the three modes and shows the mode of the active tab", () => {
    const { el, modeButton, mode, fixture } = render({ path: "/n.md", editing: true });
    const buttons = [...el.querySelectorAll(".seg button")];
    expect(buttons.map((b) => b.getAttribute("aria-label"))).toEqual([
      "Live preview",
      "Source",
      "Reading",
    ]);
    // Icons only: no visible text, an svg in each button.
    expect(buttons.map((b) => b.textContent?.trim())).toEqual(["", "", ""]);
    expect(buttons.every((b) => b.querySelector("svg path")?.getAttribute("d"))).toBe(true);
    expect(modeButton("Live preview").getAttribute("aria-pressed")).toBe("true");
    expect(modeButton("Source").getAttribute("aria-pressed")).toBe("false");
    mode.set("reading");
    fixture.detectChanges();
    expect(modeButton("Reading").getAttribute("aria-pressed")).toBe("true");
    expect(modeButton("Reading").classList.contains("active")).toBe(true);
    expect(modeButton("Live preview").classList.contains("active")).toBe(false);
    expect(el.querySelector("select")).toBeNull();
  });

  it("runs the command of the clicked mode", () => {
    const { modeButton, execute } = render({ path: "/n.md", editing: true });
    modeButton("Source").click();
    modeButton("Reading").click();
    modeButton("Live preview").click();
    expect(execute.mock.calls.map((c) => c[0])).toEqual([
      "view-source",
      "view-reading",
      "view-live",
    ]);
  });

  it("names each mode in its tooltip with the shortcut that toggles to it", () => {
    const { fixture } = render({ path: "/n.md", editing: true });
    const tips = fixture.debugElement
      .queryAll(By.css(".seg button"))
      .map((b) => b.injector.get(HxTooltip));
    expect(tips.map((t) => t.text())).toEqual(["Live preview", "Source", "Reading"]);
    expect(tips.map((t) => t.shortcut())).toEqual([
      ["Ctrl", "E"],
      ["Ctrl", "E"],
      ["Ctrl", "Alt", "E"],
    ]);
  });

  it("is disabled without a note and while an external change blocks closing", () => {
    expect(render({ path: null, editing: false }).modeButton("Source").disabled).toBe(true);
    expect(
      render({ path: "/n.md", editing: true, blocked: true }).modeButton("Source").disabled,
    ).toBe(true);
    expect(render({ path: "/n.md", editing: true }).modeButton("Source").disabled).toBe(false);
  });

  it("toggles the properties in the document with a button, not a select", () => {
    const { el, execute, propertiesDisplay, fixture } = render({ path: "/n.md", editing: true });
    expect(el.querySelector("select.props")).toBeNull();
    const button = el.querySelector<HTMLButtonElement>("button.props")!;
    expect(button.getAttribute("aria-pressed")).toBe("true");
    button.click();
    expect(execute).toHaveBeenCalledWith("toggle-properties");
    propertiesDisplay.set("hidden");
    fixture.detectChanges();
    expect(button.getAttribute("aria-pressed")).toBe("false");
  });

  it("keeps the properties button disabled without a note", () => {
    const { el } = render({ path: null, editing: false });
    expect(el.querySelector<HTMLButtonElement>("button.props")!.disabled).toBe(true);
  });
});

describe("ToolbarComponent content", () => {
  const labels = (el: HTMLElement) =>
    [...el.querySelectorAll("button")].map(
      (b) => b.getAttribute("aria-label") ?? b.textContent?.trim(),
    );

  it("keeps only back, forward, title, the modes, properties, outline and backlinks", () => {
    const { el } = render({ path: "/n.md", editing: false });
    expect(labels(el)).toEqual([
      "Back",
      "Forward",
      "n.md",
      "Live preview",
      "Source",
      "Reading",
      "Toggle properties in document",
      "Toggle outline",
      "Toggle backlinks",
    ]);
    expect(el.querySelector(".note")?.textContent?.trim()).toBe("n.md");
    expect(el.querySelector("hx-app-toolbar")).not.toBeNull();
  });

  it("goes back and forward", () => {
    const { el, forward, back } = render({ path: "/n.md", editing: false });
    const [backButton, forwardButton] = [...el.querySelectorAll("button")];
    expect(backButton.disabled).toBe(true);
    forwardButton.click();
    expect(forward).toHaveBeenCalled();
    expect(back).not.toHaveBeenCalled();
  });

  it("toggles outline and backlinks through their commands", () => {
    const { el, execute } = render({ path: "/n.md", editing: false });
    const outline = el.querySelector<HTMLButtonElement>("[aria-label='Toggle outline']")!;
    const backlinks = el.querySelector<HTMLButtonElement>("[aria-label='Toggle backlinks']")!;
    expect(outline.getAttribute("aria-pressed")).toBe("true");
    expect(backlinks.getAttribute("aria-pressed")).toBe("false");
    outline.click();
    backlinks.click();
    expect(execute).toHaveBeenCalledWith("toggle-outline");
    expect(execute).toHaveBeenCalledWith("toggle-backlinks");
  });

  it("disables outline and backlinks without a note, backlinks also without a vault", () => {
    const none = render({ path: null, editing: false }).el;
    expect(none.querySelector<HTMLButtonElement>("[aria-label='Toggle outline']")!.disabled).toBe(
      true,
    );
    const noVault = render({ path: "/n.md", editing: false, vault: false }).el;
    expect(
      noVault.querySelector<HTMLButtonElement>("[aria-label='Toggle outline']")!.disabled,
    ).toBe(false);
    expect(
      noVault.querySelector<HTMLButtonElement>("[aria-label='Toggle backlinks']")!.disabled,
    ).toBe(true);
  });
});

describe("ToolbarComponent breadcrumb", () => {
  const texts = (el: HTMLElement) =>
    [...el.querySelectorAll(".crumbs .crumb")].map((c) => c.textContent?.trim());

  it("shows the vault-relative path as segments", () => {
    const { el } = render({ path: "/v/backend/file-watching.md", editing: false });
    expect(texts(el)).toEqual(["backend", "file-watching.md"]);
  });

  it("shows the file name outside a vault", () => {
    const { el } = render({ path: "/x/backend/n.md", editing: false, vault: false });
    expect(texts(el)).toEqual(["n.md"]);
  });

  it("shortens a deep path in the middle and keeps the note name", () => {
    const { el } = render({ path: "/v/a/b/c/d/e/n.md", editing: false });
    expect(texts(el)).toEqual(["a", "…", "d", "e", "n.md"]);
  });

  it("reveals a folder in the file tree on click", async () => {
    const { el, show, reveal } = render({ path: "/v/a/b/n.md", editing: false });
    el.querySelectorAll<HTMLButtonElement>(".crumb.folder")[1].click();
    await Promise.resolve();
    expect(show).toHaveBeenCalledWith("files");
    expect(reveal).toHaveBeenCalledWith("/v/a/b/.");
  });

  it("renames the note from the last segment", async () => {
    const { el, fixture, rename } = render({ path: "/v/a/n.md", editing: false });
    el.querySelector<HTMLButtonElement>(".crumb.note")!.click();
    fixture.detectChanges();
    const input = el.querySelector<HTMLInputElement>("input.rename")!;
    expect(input.value).toBe("n.md");
    input.value = "new.md";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    await Promise.resolve();
    fixture.detectChanges();
    expect(rename).toHaveBeenCalledWith("/v/a/n.md", "new.md");
    expect(el.querySelector("input.rename")).toBeNull();
  });

  it("does not rename on Escape or an unchanged name", () => {
    const { el, fixture, rename } = render({ path: "/v/a/n.md", editing: false });
    el.querySelector<HTMLButtonElement>(".crumb.note")!.click();
    fixture.detectChanges();
    el.querySelector<HTMLInputElement>("input.rename")!.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape" }),
    );
    fixture.detectChanges();
    expect(el.querySelector("input.rename")).toBeNull();
    el.querySelector<HTMLButtonElement>(".crumb.note")!.click();
    fixture.detectChanges();
    el.querySelector<HTMLInputElement>("input.rename")!.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter" }),
    );
    expect(rename).not.toHaveBeenCalled();
  });
});

// @vitest-environment jsdom
import "@angular/compiler";
import { readFileSync } from "node:fs";
import { signal } from "@angular/core";
import { By } from "@angular/platform-browser";
import { HxTooltip } from "@gravionlabs/helix-ui";
import { TestBed } from "@angular/core/testing";
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
}) {
  const execute = vi.fn().mockReturnValue(true);
  const back = vi.fn();
  const forward = vi.fn();
  const show = vi.fn();
  const reveal = vi.fn().mockResolvedValue(undefined);
  const rename = vi.fn().mockResolvedValue("/v/new.md");
  const editing = signal(opts.editing);
  const blocked = signal(opts.blocked ?? false);
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
      { provide: EditorService, useValue: { editing, blocked } },
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
          sourceMode: signal(true),
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
  const button = [...el.querySelectorAll("button")].find(
    (b) => b.textContent?.trim() === "Source",
  )!;
  return { fixture, button, execute, editing, blocked, el, back, forward, show, reveal, rename };
}

const KEYS: Record<string, string[]> = {
  "new-note": ["Ctrl", "N"],
  "new-folder": ["Ctrl", "Shift", "N"],
  "toggle-editor": ["Ctrl", "E"],
};

describe("ToolbarComponent edit toggle", () => {
  beforeAll(() => {
    TestBed.initTestEnvironment(BrowserTestingModule, platformBrowserTesting());
  });

  it("follows editing() and runs toggle-editor on click", () => {
    const { fixture, button, execute, editing } = render({ path: "/n.md", editing: false });
    expect(button.getAttribute("aria-pressed")).toBe("false");
    expect(button.classList.contains("active")).toBe(false);
    const tip = fixture.debugElement.query(By.css("button.toggle")).injector.get(HxTooltip);
    expect(tip.text()).toBe("Toggle source mode");
    expect(tip.shortcut()).toEqual(["Ctrl", "E"]);
    button.click();
    expect(execute).toHaveBeenCalledWith("toggle-editor");
    editing.set(true);
    fixture.detectChanges();
    expect(button.getAttribute("aria-pressed")).toBe("true");
    expect(button.classList.contains("active")).toBe(true);
  });

  it("is disabled without a note and while an external change blocks closing", () => {
    expect(render({ path: null, editing: false }).button.disabled).toBe(true);
    expect(render({ path: "/n.md", editing: true, blocked: true }).button.disabled).toBe(true);
    expect(render({ path: "/n.md", editing: true }).button.disabled).toBe(false);
  });
});

describe("ToolbarComponent content", () => {
  const labels = (el: HTMLElement) =>
    [...el.querySelectorAll("button")].map(
      (b) => b.getAttribute("aria-label") ?? b.textContent?.trim(),
    );

  it("keeps only back, forward, title, edit, outline and backlinks", () => {
    const { el } = render({ path: "/n.md", editing: false });
    expect(labels(el)).toEqual([
      "Back",
      "Forward",
      "n.md",
      "Source",
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

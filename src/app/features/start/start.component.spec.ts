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

import { CommandRegistry } from "../../core/commands/command-registry";
import { ShortcutService } from "../../core/commands/shortcut.service";
import { DocumentService } from "../../core/file/document.service";
import { SettingsService } from "../../core/settings/settings.service";
import { SwitcherService } from "../../core/switcher/switcher.service";
import { WorkspaceService } from "../../core/workspace/workspace.service";
import { StartComponent } from "./start.component";

interface Options {
  vault?: string | null;
  notes?: string[];
  vaults?: string[];
  openRecent?: boolean;
}

function render({ vault = null, notes = [], vaults = [], openRecent = true }: Options = {}) {
  const commands = { execute: vi.fn() };
  const doc = { open: vi.fn().mockResolvedValue(undefined) };
  const workspace = { vaultRoot: signal(vault), openRecent: vi.fn().mockResolvedValue(openRecent) };
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      { provide: CommandRegistry, useValue: commands },
      {
        provide: ShortcutService,
        useValue: {
          display: (id: string) => ({ "quick-switcher": "Ctrl+O", "new-note": "Ctrl+N" })[id] ?? "",
        },
      },
      { provide: SettingsService, useValue: { recentVaults: signal(vaults) } },
      { provide: SwitcherService, useValue: { recentNotes: signal(notes) } },
      { provide: DocumentService, useValue: doc },
      { provide: WorkspaceService, useValue: workspace },
    ],
  });
  TestBed.overrideComponent(StartComponent, {
    set: {
      templateUrl: undefined,
      styleUrl: undefined,
      template: readFileSync("src/app/features/start/start.component.html", "utf8"),
    },
  });
  const fixture = TestBed.createComponent(StartComponent);
  const errors: string[] = [];
  fixture.componentInstance.error.subscribe((e) => errors.push(e));
  fixture.detectChanges();
  const el = fixture.nativeElement as HTMLElement;
  const buttons = () => Array.from(el.querySelectorAll("button"));
  return { commands, doc, workspace, el, errors, buttons, fixture };
}

describe("StartComponent", () => {
  beforeAll(() => {
    TestBed.initTestEnvironment(BrowserTestingModule, platformBrowserTesting());
  });

  it("without a vault offers open folder, clone vault, open file and the recent vaults", () => {
    const { buttons, el } = render({ vaults: ["/home/me/notes", "/home/me/work"] });
    expect(buttons().map((b) => b.textContent!.trim())).toEqual([
      "Open folder",
      "Clone vault",
      "Open file",
      "notes",
      "work",
    ]);
    expect(el.textContent).toContain("Recent vaults");
    expect(el.textContent).not.toContain("Recent notes");
  });

  it("opens a recent vault and reports one that is gone", async () => {
    const { buttons, workspace, errors } = render({
      vaults: ["/home/me/notes"],
      openRecent: false,
    });
    buttons()[3].click();
    await vi.waitFor(() => expect(errors).toHaveLength(1));
    expect(workspace.openRecent).toHaveBeenCalledWith("/home/me/notes");
    expect(errors[0]).toContain("/home/me/notes");
  });

  it("in a vault offers the daily note, new note and quick switcher with their shortcuts, and the recent notes", () => {
    const { buttons, el } = render({ vault: "/v", notes: ["Inbox/Alpha.md", "Beta.md"] });
    expect(buttons().map((b) => b.textContent!.replace(/\s+/g, " ").trim())).toEqual([
      "Open the daily note",
      "New note Ctrl+N",
      "Quick switcher Ctrl+O",
      "Alpha",
      "Beta",
    ]);
    expect(el.textContent).toContain("Recent notes");
    expect(el.textContent).not.toContain("Clone vault");
  });

  it("runs the command of an action", () => {
    const { buttons, commands } = render({ vault: "/v" });
    buttons()[0].click();
    buttons()[2].click();
    expect(commands.execute.mock.calls).toEqual([["daily-note"], ["quick-switcher"]]);
  });

  it("opens a recent note from the vault", async () => {
    const { buttons, doc } = render({ vault: "/v", notes: ["Inbox/Alpha.md"] });
    buttons()[3].click();
    await vi.waitFor(() => expect(doc.open).toHaveBeenCalledWith("/v/Inbox/Alpha.md"));
  });

  it("describes the vault app and has no long shortcut list", () => {
    const { el } = render();
    expect(el.textContent).not.toContain("Mermaid");
    expect(el.querySelector("dl")).toBeNull();
  });
});

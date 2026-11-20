// @vitest-environment jsdom
import "@angular/compiler";
import { signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { BrowserTestingModule, platformBrowserTesting } from "@angular/platform-browser/testing";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { CommandRegistry } from "../commands/command-registry";
import { DocumentService } from "../file/document.service";
import { SettingsService } from "../settings/settings.service";
import { TabsService } from "../tabs/tabs.service";
import { WorkspaceService } from "../workspace/workspace.service";
import { FocusService, KEYBOARD_FOCUS_ATTRIBUTE } from "./focus.service";
import { ShellService } from "./shell.service";

describe("FocusService", () => {
  const root = signal<string | null>("/v");
  const path = signal<string | null>("/v/a.md");
  const panelOpen = signal(true);
  const show = vi.fn();
  const showPanelTab = vi.fn(() => panelOpen.set(true));
  let focus: FocusService;
  let commands: CommandRegistry;

  beforeAll(() => TestBed.initTestEnvironment(BrowserTestingModule, platformBrowserTesting()));

  beforeEach(() => {
    root.set("/v");
    path.set("/v/a.md");
    panelOpen.set(true);
    show.mockClear();
    showPanelTab.mockClear();
    document.body.innerHTML = `
      <app-sidebar><input class="filter" id="filter"><div class="row" tabindex="-1" id="first"></div><div class="row" tabindex="0" id="stop"></div></app-sidebar>
      <app-workspace><section class="pane"><div class="markdown-body" tabindex="-1" id="viewer"></div></section></app-workspace>
      <div class="panel"><div class="panel-tabs"><button id="outline">Outline</button><button class="active" id="links">Links</button></div></div>`;
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        { provide: ShellService, useValue: { show } },
        {
          provide: SettingsService,
          useValue: { panelOpen, panelTab: () => "links", showPanelTab },
        },
        { provide: WorkspaceService, useValue: { root } },
        { provide: DocumentService, useValue: { path } },
        {
          provide: TabsService,
          useValue: { panes: () => [{ id: 1 }], focusedPane: () => ({ id: 1 }) },
        },
      ],
    });
    commands = TestBed.inject(CommandRegistry);
    focus = TestBed.inject(FocusService);
  });

  afterEach(() => {
    vi.useRealTimers();
    document.documentElement.removeAttribute(KEYBOARD_FOCUS_ATTRIBUTE);
  });

  it("registers the three commands with default shortcuts that can be changed", () => {
    for (const id of ["focus-file-tree", "focus-note", "focus-panel"]) {
      const command = commands.all().find((c) => c.id === id)!;
      expect(command.shortcut).toBeTruthy();
      expect(commands.keysOf(command)).toEqual(command.keys);
      commands.overrides.set({ [id]: "Mod+Alt+K" });
      expect(commands.keysOf(command)).toEqual(["Mod+Alt+K"]);
      commands.overrides.set({});
    }
  });

  it("focuses the tab stop of the tree, shows the files and marks the focus ring", async () => {
    await focus.focusFileTree();
    expect(show).toHaveBeenCalledWith("files");
    expect(document.activeElement?.id).toBe("stop");
    expect(document.documentElement.hasAttribute(KEYBOARD_FOCUS_ATTRIBUTE)).toBe(true);
  });

  it("focuses the filter field of the tree with a command that has a shortcut", async () => {
    const command = commands.all().find((c) => c.id === "filter-file-tree")!;
    expect(command.title).toBe("Filter file tree");
    expect(command.shortcut).toBeTruthy();
    await focus.focusFilter();
    expect(show).toHaveBeenCalledWith("files");
    expect(document.activeElement?.id).toBe("filter");
  });

  it("focuses the note", async () => {
    await focus.focusNote();
    expect(document.activeElement?.id).toBe("viewer");
  });

  it("focuses the active tab of the panel", async () => {
    await focus.focusPanel();
    expect(showPanelTab).not.toHaveBeenCalled();
    expect(document.activeElement?.id).toBe("links");
  });

  it("opens a collapsed panel first and waits until it is rendered", async () => {
    vi.useFakeTimers();
    const panel = document.querySelector(".panel")!;
    panel.remove();
    panelOpen.set(false);
    const done = focus.focusPanel();
    expect(showPanelTab).toHaveBeenCalledWith("links");
    await vi.advanceTimersByTimeAsync(50);
    document.body.append(panel);
    await vi.advanceTimersByTimeAsync(50);
    expect(await done).toBe(true);
    expect(document.activeElement?.id).toBe("links");
  });

  it("gives up when the region never appears", async () => {
    vi.useFakeTimers();
    document.querySelector(".panel")!.remove();
    const done = focus.focusPanel();
    await vi.advanceTimersByTimeAsync(1000);
    expect(await done).toBe(false);
  });

  it("is available only where it makes sense", () => {
    root.set(null);
    path.set(null);
    const when = (id: string) => commands.all().find((c) => c.id === id)!.when!();
    expect(when("focus-file-tree")).toBe(false);
    expect(when("focus-note")).toBe(false);
    expect(when("focus-panel")).toBe(false);
  });

  it("moves the focus back to the note on Escape in the tree or the panel", async () => {
    for (const id of ["stop", "links"]) {
      const target = document.getElementById(id)!;
      target.focus();
      const event = new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      });
      Object.defineProperty(event, "target", { value: target });
      expect(focus.handleEscape(event)).toBe(true);
      await vi.waitFor(() => expect(document.activeElement?.id).toBe("viewer"));
    }
  });

  it("leaves Escape alone in a text field, outside the regions, and without a note", () => {
    const input = document.createElement("input");
    document.querySelector("app-sidebar")!.append(input);
    const press = (target: Element) => {
      const event = new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      });
      Object.defineProperty(event, "target", { value: target });
      return focus.handleEscape(event);
    };
    expect(press(input)).toBe(false);
    expect(press(document.getElementById("viewer")!)).toBe(false);
    path.set(null);
    expect(press(document.getElementById("stop")!)).toBe(false);
  });
});

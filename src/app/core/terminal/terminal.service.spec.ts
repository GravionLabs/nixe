// @vitest-environment jsdom
import "@angular/compiler";
import { signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { BrowserTestingModule, platformBrowserTesting } from "@angular/platform-browser/testing";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const ask = vi.hoisted(() => vi.fn());
const platform = vi.hoisted(() => ({ kind: "desktop" }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ ask }));
vi.mock("@gravionlabs/helix-desktop", () => ({
  getHxPlatform: () => platform.kind,
  getHxPlatformKind: (p: string) => p,
}));

import { CommandRegistry } from "../commands/command-registry";
import { SettingsService } from "../settings/settings.service";
import { WorkspaceService } from "../workspace/workspace.service";
import { TERMINAL_OFF_NOTICE, TerminalService } from "./terminal.service";

describe("TerminalService", () => {
  const terminalEnabled = signal(false);
  const terminalConfirmed = signal(false);
  const terminalVisible = signal(false);
  const vaultRoot = signal<string | null>("/v");

  beforeAll(() => TestBed.initTestEnvironment(BrowserTestingModule, platformBrowserTesting()));

  function create(kind = "desktop"): { service: TerminalService; commands: CommandRegistry } {
    platform.kind = kind;
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        {
          provide: SettingsService,
          useValue: { terminalEnabled, terminalConfirmed, terminalVisible },
        },
        { provide: WorkspaceService, useValue: { vaultRoot } },
      ],
    });
    const commands = TestBed.inject(CommandRegistry);
    return { service: TestBed.inject(TerminalService), commands };
  }

  beforeEach(() => {
    terminalEnabled.set(false);
    terminalConfirmed.set(false);
    terminalVisible.set(false);
    vaultRoot.set("/v");
    ask.mockReset();
  });

  it("registers the toggle-terminal command with a shortcut", () => {
    const { commands } = create();
    const command = commands.all().find((c) => c.id === "toggle-terminal");
    expect(command?.shortcut).toBe("Mod+`");
    expect(commands.available().some((c) => c.id === "toggle-terminal")).toBe(true);
  });

  it("is not available without a vault", () => {
    vaultRoot.set(null);
    const { commands } = create();
    expect(commands.available().some((c) => c.id === "toggle-terminal")).toBe(false);
  });

  it("shows and hides the panel while the terminal is enabled", () => {
    terminalEnabled.set(true);
    const { service, commands } = create();
    expect(service.open()).toBe(false);
    commands.execute("toggle-terminal");
    expect(terminalVisible()).toBe(true);
    expect(service.open()).toBe(true);
    commands.execute("toggle-terminal");
    expect(terminalVisible()).toBe(false);
    expect(service.open()).toBe(false);
  });

  it("only points to the setting while the terminal is off", () => {
    const { service, commands } = create();
    commands.execute("toggle-terminal");
    expect(terminalVisible()).toBe(false);
    expect(service.open()).toBe(false);
    expect(service.notice()).toBe(TERMINAL_OFF_NOTICE);
    expect(TERMINAL_OFF_NOTICE).toContain("Enable terminal");
  });

  it("asks once before the terminal is enabled", async () => {
    ask.mockResolvedValue(true);
    const { service } = create();
    expect(await service.setEnabled(true)).toBe(true);
    expect(ask).toHaveBeenCalledTimes(1);
    expect(terminalEnabled()).toBe(true);
    expect(terminalConfirmed()).toBe(true);

    await service.setEnabled(false);
    expect(terminalEnabled()).toBe(false);
    expect(await service.setEnabled(true)).toBe(true);
    expect(ask).toHaveBeenCalledTimes(1);
    expect(terminalEnabled()).toBe(true);
  });

  it("stays off when the confirmation is declined, and asks again next time", async () => {
    ask.mockResolvedValue(false);
    const { service } = create();
    expect(await service.setEnabled(true)).toBe(false);
    expect(terminalEnabled()).toBe(false);
    expect(terminalConfirmed()).toBe(false);
    await service.setEnabled(true);
    expect(ask).toHaveBeenCalledTimes(2);
  });

  it("hides the panel when the terminal is turned off", async () => {
    terminalEnabled.set(true);
    terminalConfirmed.set(true);
    terminalVisible.set(true);
    const { service } = create();
    await service.setEnabled(false);
    expect(terminalVisible()).toBe(false);
    expect(service.open()).toBe(false);
  });

  it("does not exist on iOS: no command, no toggle, no setting", async () => {
    terminalEnabled.set(true);
    const { service, commands } = create("mobile");
    expect(service.supported).toBe(false);
    expect(commands.all().some((c) => c.id === "toggle-terminal")).toBe(false);
    service.toggle();
    expect(terminalVisible()).toBe(false);
    expect(await service.setEnabled(true)).toBe(false);
    expect(ask).not.toHaveBeenCalled();
    expect(service.open()).toBe(false);
  });

  describe("tabs", () => {
    beforeEach(() => {
      terminalEnabled.set(true);
      terminalVisible.set(true);
    });

    it("seeds one tab per vault, and a closed last tab is not replaced", () => {
      const { service } = create();
      service.seed();
      service.seed();
      expect(service.tabs().map((t) => t.title)).toEqual(["Terminal 1"]);
      service.closeTab();
      expect(service.tabs()).toEqual([]);
      expect(service.activeKey()).toBeNull();
      service.seed();
      expect(service.tabs()).toEqual([]);
      service.reset();
      service.seed();
      expect(service.tabs()).toHaveLength(1);
    });

    it("opens, switches and closes tabs", () => {
      const { service } = create();
      service.newTab();
      service.newTab();
      service.newTab();
      const [a, b, c] = service.tabs().map((t) => t.key);
      expect(service.activeKey()).toBe(c);
      service.selectTab(a);
      expect(service.activeKey()).toBe(a);
      service.selectTab(999);
      expect(service.activeKey()).toBe(a);
      service.closeTab(a);
      expect(service.activeKey()).toBe(b);
      service.closeTab(c);
      expect(service.tabs().map((t) => t.key)).toEqual([b]);
      expect(service.activeKey()).toBe(b);
      service.closeTab(999);
      expect(service.tabs()).toHaveLength(1);
    });

    it("registers new and close tab in the palette", () => {
      terminalVisible.set(false);
      const { service, commands } = create();
      expect(commands.available().some((c) => c.id === "new-terminal-tab")).toBe(true);
      expect(commands.available().some((c) => c.id === "close-terminal-tab")).toBe(false);
      commands.execute("new-terminal-tab");
      expect(terminalVisible()).toBe(true);
      expect(service.tabs()).toHaveLength(1);
      expect(commands.available().some((c) => c.id === "close-terminal-tab")).toBe(true);
      commands.execute("close-terminal-tab");
      expect(service.tabs()).toEqual([]);
    });

    it("does not open a tab while the terminal is off", () => {
      terminalEnabled.set(false);
      const { service } = create();
      service.newTab();
      expect(service.tabs()).toEqual([]);
      expect(service.notice()).toBe(TERMINAL_OFF_NOTICE);
    });

    it("forgets the tabs when the terminal is turned off", async () => {
      const { service } = create();
      service.newTab();
      await service.setEnabled(false);
      expect(service.tabs()).toEqual([]);
    });

    it("has no tab commands on iOS", () => {
      const { commands } = create("mobile");
      expect(commands.all().some((c) => c.id.endsWith("-terminal-tab"))).toBe(false);
    });
  });
});

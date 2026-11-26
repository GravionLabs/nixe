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
import { TerminalBackend } from "./terminal-backend";
import { SKILLS_UPDATE_PRESET, TERMINAL_PRESETS, VAULT_SETUP_PRESET } from "./terminal-presets";
import {
  TERMINAL_CONFIRM,
  TERMINAL_OFF_CONFIRM,
  TERMINAL_OFF_QUESTION,
  TerminalService,
} from "./terminal.service";

describe("TerminalService", () => {
  const terminalEnabled = signal(false);
  const terminalConfirmed = signal(false);
  const terminalVisible = signal(false);
  const vaultRoot = signal<string | null>("/v");
  const backend = { checkPreset: vi.fn<(id: string) => Promise<void>>() };
  const save = vi.fn<() => Promise<void>>();

  beforeAll(() => TestBed.initTestEnvironment(BrowserTestingModule, platformBrowserTesting()));

  function create(kind = "desktop"): { service: TerminalService; commands: CommandRegistry } {
    platform.kind = kind;
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        {
          provide: SettingsService,
          useValue: { terminalEnabled, terminalConfirmed, terminalVisible, save },
        },
        { provide: WorkspaceService, useValue: { vaultRoot } },
        { provide: TerminalBackend, useValue: backend },
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
    backend.checkPreset.mockReset().mockResolvedValue(undefined);
    save.mockReset().mockResolvedValue(undefined);
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

  describe("while the terminal is off", () => {
    const triggers = [
      ["toggle-terminal", 0],
      ["new-terminal-tab", 1],
      ["open-claude-in-vault", 1],
      ["open-copilot-in-vault", 1],
    ] as const;
    const settled = () => new Promise((resolve) => setTimeout(resolve));

    it.each(triggers)("%s asks, enables on yes and runs the action", async (id, tabs) => {
      ask.mockResolvedValue(true);
      const { service, commands } = create();
      commands.execute(id);
      await settled();
      expect(ask).toHaveBeenCalledTimes(1);
      expect(ask.mock.calls[0][0]).toBe(TERMINAL_OFF_CONFIRM);
      expect(terminalEnabled()).toBe(true);
      expect(terminalConfirmed()).toBe(true);
      expect(service.open()).toBe(true);
      expect(service.tabs()).toHaveLength(tabs);
      const preset = TERMINAL_PRESETS.find((p) => p.commandId === id)?.id ?? null;
      expect(service.tabs().map((t) => t.preset)).toEqual(tabs ? [preset] : []);
    });

    it.each(triggers)("%s changes nothing when declined, and asks again", async (id) => {
      ask.mockResolvedValue(false);
      const { service, commands } = create();
      commands.execute(id);
      await settled();
      expect(terminalEnabled()).toBe(false);
      expect(terminalConfirmed()).toBe(false);
      expect(terminalVisible()).toBe(false);
      expect(service.tabs()).toEqual([]);
      expect(service.notice()).toBeNull();
      expect(save).not.toHaveBeenCalled();
      expect(backend.checkPreset).not.toHaveBeenCalled();
      commands.execute(id);
      await settled();
      expect(ask).toHaveBeenCalledTimes(2);
    });

    it("carries the security warning only while never confirmed", async () => {
      expect(TERMINAL_OFF_CONFIRM).toContain(TERMINAL_CONFIRM);
      terminalConfirmed.set(true);
      ask.mockResolvedValue(false);
      const { service } = create();
      service.toggle();
      await settled();
      expect(ask.mock.calls[0][0]).toBe(TERMINAL_OFF_QUESTION);
    });

    it("shows the panel after yes, also when it was stored as visible", async () => {
      terminalVisible.set(true);
      ask.mockResolvedValue(true);
      const { service } = create();
      service.toggle();
      await settled();
      expect(service.open()).toBe(true);
    });

    it("opens one dialog only, and runs only its action", async () => {
      let answer!: (yes: boolean) => void;
      ask.mockReturnValue(new Promise<boolean>((resolve) => (answer = resolve)));
      const { service } = create();
      service.newTab();
      service.newTab();
      service.toggle();
      expect(await service.openPreset(TERMINAL_PRESETS[0])).toBe(false);
      expect(await service.setEnabled(true)).toBe(false);
      expect(ask).toHaveBeenCalledTimes(1);
      answer(true);
      await settled();
      expect(service.tabs()).toHaveLength(1);
      expect(terminalVisible()).toBe(true);
    });

    it("opens no second dialog while the one of the setting is open", async () => {
      ask.mockReturnValue(new Promise<boolean>(() => undefined));
      const { service } = create();
      void service.setEnabled(true);
      service.newTab();
      await settled();
      expect(ask).toHaveBeenCalledTimes(1);
    });

    it("runs the action only once the setting is saved", async () => {
      let saved!: () => void;
      save.mockReturnValue(new Promise<void>((resolve) => (saved = resolve)));
      ask.mockResolvedValue(true);
      const { service } = create();
      const opened = service.openPreset(TERMINAL_PRESETS[0]);
      await settled();
      service.newTab();
      expect(save).toHaveBeenCalledTimes(1);
      expect(backend.checkPreset).not.toHaveBeenCalled();
      expect(service.tabs()).toEqual([]);
      expect(terminalVisible()).toBe(false);
      saved();
      expect(await opened).toBe(true);
      expect(service.tabs()).toHaveLength(1);
    });

    it.each([SKILLS_UPDATE_PRESET, VAULT_SETUP_PRESET])(
      "asks for the preset $id of the vault skills too",
      async (preset) => {
        ask.mockResolvedValue(true);
        const { service } = create();
        expect(await service.openPreset(preset)).toBe(true);
        expect(ask).toHaveBeenCalledTimes(1);
        expect(service.tabs()[0].preset).toBe(preset.id);
      },
    );
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

  describe("presets", () => {
    beforeEach(() => terminalEnabled.set(true));

    it("lists Claude and Copilot as data with one command each", () => {
      expect(TERMINAL_PRESETS.map((p) => p.id)).toEqual(["claude", "copilot"]);
      const { commands } = create();
      const titles = commands.available().map((c) => c.title);
      expect(titles).toContain("Open Claude in the vault");
      expect(titles).toContain("Open Copilot in the vault");
    });

    it("opens a titled tab with the preset and shows the panel", async () => {
      const { service, commands } = create();
      commands.execute("open-copilot-in-vault");
      await vi.waitFor(() => expect(service.tabs()).toHaveLength(1));
      expect(backend.checkPreset).toHaveBeenCalledWith("copilot");
      expect(service.tabs()[0]).toMatchObject({ title: "Copilot", preset: "copilot" });
      expect(service.activeKey()).toBe(service.tabs()[0].key);
      expect(terminalVisible()).toBe(true);
    });

    it.each(TERMINAL_PRESETS)(
      "opens a shell tab and shows the install hint when the CLI of $id is missing",
      async (preset) => {
        backend.checkPreset.mockRejectedValue("The CLI is not installed.");
        const { service } = create();
        const onExit = vi.fn();
        expect(await service.openPreset(preset, onExit)).toBe(false);
        expect(service.tabs()).toEqual([{ key: 1, title: "Terminal 1", preset: null }]);
        expect(service.activeKey()).toBe(1);
        expect(terminalVisible()).toBe(true);
        expect(service.notice()).toBe("The CLI is not installed.");
        service.ended(1);
        expect(onExit).not.toHaveBeenCalled();
      },
    );

    it.each([SKILLS_UPDATE_PRESET, VAULT_SETUP_PRESET])(
      "opens no shell for the missing CLI of $id",
      async (preset) => {
        backend.checkPreset.mockRejectedValue("Not installed.");
        const { service } = create();
        expect(await service.openPreset(preset)).toBe(false);
        expect(service.tabs()).toEqual([]);
        expect(terminalVisible()).toBe(false);
        expect(service.notice()).toBe("Not installed.");
      },
    );

    it("runs the exit handler of a preset tab once, and not after the tab is closed", async () => {
      const { service } = create();
      const onExit = vi.fn();
      expect(await service.openPreset(TERMINAL_PRESETS[0], onExit)).toBe(true);
      const key = service.tabs()[0].key;
      service.ended(key);
      service.ended(key);
      expect(onExit).toHaveBeenCalledTimes(1);

      const closed = vi.fn();
      await service.openPreset(TERMINAL_PRESETS[0], closed);
      const second = service.tabs()[1].key;
      service.closeTab(second);
      service.ended(second);
      expect(closed).not.toHaveBeenCalled();
    });

    it("has no preset command on iOS", () => {
      const { commands } = create("mobile");
      expect(commands.all().some((c) => c.id === "open-claude-in-vault")).toBe(false);
    });
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

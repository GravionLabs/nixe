import { Injectable, computed, inject, signal } from "@angular/core";
import { ask } from "@tauri-apps/plugin-dialog";
import { getHxPlatform, getHxPlatformKind } from "@gravionlabs/helix-desktop";

import { CommandRegistry } from "../commands/command-registry";
import { SettingsService } from "../settings/settings.service";
import { WorkspaceService } from "../workspace/workspace.service";
import { TerminalBackend } from "./terminal-backend";
import { TERMINAL_PRESETS, type TerminalPreset } from "./terminal-presets";

export const TERMINAL_CONFIRM =
  "The terminal runs commands with your rights, like any program you start. A vault from someone else, or a note that tells you to paste a command, can harm your computer. Enable the terminal?";

/** The question of an action that needs the terminal, once the user has confirmed it before. */
export const TERMINAL_OFF_QUESTION = "The terminal is off. Enable the terminal?";

/** The same question with the security warning, while the user has never confirmed. */
export const TERMINAL_OFF_CONFIRM = `The terminal is off. ${TERMINAL_CONFIRM}`;

/** One tab of the panel: its own session; `key` is stable for the life of the tab. */
export interface TerminalTab {
  readonly key: number;
  readonly title: string;
  /** The preset whose CLI runs in the tab instead of the shell. */
  readonly preset: string | null;
}

/** The bottom panel with the shell: the command, the opt-in setting and its confirmation. Desktop only. */
@Injectable({ providedIn: "root" })
export class TerminalService {
  private readonly settings = inject(SettingsService);
  private readonly workspace = inject(WorkspaceService);
  private readonly commands = inject(CommandRegistry);
  private readonly backend = inject(TerminalBackend);

  /** iOS has no process spawning: there the command, the setting and the panel are absent. */
  readonly supported = getHxPlatformKind(getHxPlatform()) !== "mobile";
  /** A message for the toast; the app clears it. */
  readonly notice = signal<string | null>(null);
  /** The panel is shown: enabled, wanted and a vault is open. */
  readonly open = computed(
    () =>
      this.supported &&
      this.settings.terminalEnabled() &&
      this.settings.terminalVisible() &&
      this.workspace.vaultRoot() !== null,
  );

  /** The tabs of the panel, in order. */
  readonly tabs = signal<readonly TerminalTab[]>([]);
  /** The key of the shown tab, or null while there is none. */
  readonly activeKey = signal<number | null>(null);
  private nextKey = 1;
  /** The first tab of a vault was opened; closing the last tab then leaves the panel empty. */
  private seeded = false;
  private readonly exitHandlers = new Map<number, () => void>();
  /** A dialog to enable the terminal is open, or its answer is being saved. */
  private enabling = false;

  constructor() {
    if (!this.supported) return;
    this.commands.register({
      id: "new-terminal-tab",
      group: "View",
      title: "New terminal tab",
      when: () => this.workspace.vaultRoot() !== null,
      run: () => this.newTab(),
    });
    for (const preset of TERMINAL_PRESETS) {
      this.commands.register({
        id: preset.commandId,
        group: "View",
        title: preset.commandTitle,
        when: () => this.workspace.vaultRoot() !== null,
        run: () => this.openPreset(preset),
      });
    }
    this.commands.register({
      id: "close-terminal-tab",
      group: "View",
      title: "Close terminal tab",
      when: () => this.open() && this.activeKey() !== null,
      run: () => this.closeTab(),
    });
    this.commands.register({
      id: "toggle-terminal",
      group: "View",
      title: "Toggle terminal",
      shortcut: "Mod+`",
      keys: ["Mod+`"],
      when: () => this.workspace.vaultRoot() !== null,
      run: () => this.toggle(),
    });
  }

  /** Shows or hides the panel; the session lives on. While the terminal is off it offers to enable it, then shows the panel. */
  toggle(): void {
    if (!this.supported) return;
    if (this.ready()) {
      this.settings.terminalVisible.update((v) => !v);
      return;
    }
    void this.offerEnable().then((ok) => {
      if (ok) this.settings.terminalVisible.set(true);
    });
  }

  /** Opens a tab with its own session and shows it, also the panel. While the terminal is off it offers to enable it first. */
  newTab(): void {
    if (!this.supported) return;
    if (this.ready()) {
      this.showTab();
      return;
    }
    void this.offerEnable().then((ok) => {
      if (ok) this.showTab();
    });
  }

  /**
   * Opens a tab that runs the CLI of `preset` in the vault root. While the terminal is off it offers to
   * enable it first. A missing CLI is found out before: the notice carries the install hint, and a
   * preset of `TERMINAL_PRESETS` opens a tab with the default shell instead. Returns whether the tab of
   * the preset opened.
   */
  async openPreset(preset: TerminalPreset, onExit?: () => void): Promise<boolean> {
    if (!this.supported) return false;
    if (!this.ready() && !(await this.offerEnable())) return false;
    try {
      await this.backend.checkPreset(preset.id);
    } catch (err) {
      this.notice.set(String(err));
      if (TERMINAL_PRESETS.includes(preset)) this.showTab();
      return false;
    }
    const key = this.showTab(preset);
    if (onExit) this.exitHandlers.set(key, onExit);
    return true;
  }

  /** The terminal is on and its setting is saved: an action can run at once. */
  private ready(): boolean {
    return this.settings.terminalEnabled() && !this.enabling;
  }

  /**
   * Asks whether to enable the terminal, with the security warning while it was never confirmed.
   * Resolves to true once it is enabled and saved (the Rust core reads the settings file), and to
   * false when declined or while another such dialog is open.
   */
  private async offerEnable(): Promise<boolean> {
    const confirmed = this.settings.terminalConfirmed();
    return this.exclusively(async () => {
      if (!(await this.confirm(confirmed ? TERMINAL_OFF_QUESTION : TERMINAL_OFF_CONFIRM)))
        return false;
      this.settings.terminalConfirmed.set(true);
      this.settings.terminalEnabled.set(true);
      await this.settings.save();
      return true;
    });
  }

  /** Runs `enable` unless one is running already; then it resolves to false at once. */
  private async exclusively(enable: () => Promise<boolean>): Promise<boolean> {
    if (this.enabling) return false;
    this.enabling = true;
    try {
      return await enable();
    } finally {
      this.enabling = false;
    }
  }

  private confirm(message: string): Promise<boolean> {
    return ask(message, { title: "Enable terminal", okLabel: "Enable", kind: "warning" });
  }

  private showTab(preset: TerminalPreset | null = null): number {
    this.settings.terminalVisible.set(true);
    return this.addTab(preset);
  }

  /** The panel reports that the process of a tab ended; a handler of `openPreset` runs once. */
  ended(key: number): void {
    const handler = this.exitHandlers.get(key);
    this.exitHandlers.delete(key);
    handler?.();
  }

  /** Opens the first tab of a vault once; the panel calls it when it is first shown. */
  seed(): void {
    if (!this.seeded) this.addTab();
  }

  private addTab(preset: TerminalPreset | null = null): number {
    this.seeded = true;
    const key = this.nextKey++;
    const title = preset?.title ?? `Terminal ${key}`;
    this.tabs.update((tabs) => [...tabs, { key, title, preset: preset?.id ?? null }]);
    this.activeKey.set(key);
    return key;
  }

  selectTab(key: number): void {
    if (this.tabs().some((t) => t.key === key)) this.activeKey.set(key);
  }

  /** Closes a tab (default: the shown one) and with it its session; the panel stays open, also when it was the last. */
  closeTab(key: number | null = this.activeKey()): void {
    const tabs = this.tabs();
    const index = tabs.findIndex((t) => t.key === key);
    if (index < 0) return;
    const rest = tabs.filter((t) => t.key !== key);
    this.tabs.set(rest);
    this.exitHandlers.delete(key as number);
    if (this.activeKey() === key)
      this.activeKey.set(rest[Math.min(index, rest.length - 1)]?.key ?? null);
  }

  /** Forgets all tabs, for a new vault or a terminal that is turned off; the next vault starts with one tab again. */
  reset(): void {
    this.tabs.set([]);
    this.activeKey.set(null);
    this.seeded = false;
    this.exitHandlers.clear();
  }

  /** Turns the terminal on or off; turning it on asks once. Returns whether the setting changed to `value`. */
  async setEnabled(value: boolean): Promise<boolean> {
    if (!this.supported) return false;
    if (value && !this.settings.terminalConfirmed()) {
      const ok = await this.exclusively(() => this.confirm(TERMINAL_CONFIRM));
      if (!ok) return false;
      this.settings.terminalConfirmed.set(true);
    }
    this.settings.terminalEnabled.set(value);
    if (!value) {
      this.settings.terminalVisible.set(false);
      this.reset();
    }
    return true;
  }
}

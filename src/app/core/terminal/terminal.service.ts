import { Injectable, computed, inject, signal } from "@angular/core";
import { ask } from "@tauri-apps/plugin-dialog";
import { getHxPlatform, getHxPlatformKind } from "@gravionlabs/helix-desktop";

import { CommandRegistry } from "../commands/command-registry";
import { SettingsService } from "../settings/settings.service";
import { WorkspaceService } from "../workspace/workspace.service";

export const TERMINAL_OFF_NOTICE =
  "The terminal is off. Turn on “Enable terminal” in the settings to use it.";

export const TERMINAL_CONFIRM =
  "The terminal runs commands with your rights, like any program you start. A vault from someone else, or a note that tells you to paste a command, can harm your computer. Enable the terminal?";

/** One tab of the panel: its own session; `key` is stable for the life of the tab. */
export interface TerminalTab {
  readonly key: number;
  readonly title: string;
}

/** The bottom panel with the shell: the command, the opt-in setting and its confirmation. Desktop only. */
@Injectable({ providedIn: "root" })
export class TerminalService {
  private readonly settings = inject(SettingsService);
  private readonly workspace = inject(WorkspaceService);
  private readonly commands = inject(CommandRegistry);

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

  constructor() {
    if (!this.supported) return;
    this.commands.register({
      id: "new-terminal-tab",
      title: "New terminal tab",
      when: () => this.workspace.vaultRoot() !== null,
      run: () => this.newTab(),
    });
    this.commands.register({
      id: "close-terminal-tab",
      title: "Close terminal tab",
      when: () => this.open() && this.activeKey() !== null,
      run: () => this.closeTab(),
    });
    this.commands.register({
      id: "toggle-terminal",
      title: "Toggle terminal",
      shortcut: "Mod+`",
      keys: ["Mod+`"],
      when: () => this.workspace.vaultRoot() !== null,
      run: () => this.toggle(),
    });
  }

  /** Shows or hides the panel; the session lives on. While the terminal is off it explains the setting. */
  toggle(): void {
    if (!this.supported) return;
    if (!this.settings.terminalEnabled()) {
      this.notice.set(TERMINAL_OFF_NOTICE);
      return;
    }
    this.settings.terminalVisible.update((v) => !v);
  }

  /** Opens a tab with its own session and shows it, also the panel. While the terminal is off it explains the setting. */
  newTab(): void {
    if (!this.supported) return;
    if (!this.settings.terminalEnabled()) {
      this.notice.set(TERMINAL_OFF_NOTICE);
      return;
    }
    this.settings.terminalVisible.set(true);
    this.addTab();
  }

  /** Opens the first tab of a vault once; the panel calls it when it is first shown. */
  seed(): void {
    if (!this.seeded) this.addTab();
  }

  private addTab(): void {
    this.seeded = true;
    const key = this.nextKey++;
    this.tabs.update((tabs) => [...tabs, { key, title: `Terminal ${key}` }]);
    this.activeKey.set(key);
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
    if (this.activeKey() === key)
      this.activeKey.set(rest[Math.min(index, rest.length - 1)]?.key ?? null);
  }

  /** Forgets all tabs, for a new vault or a terminal that is turned off; the next vault starts with one tab again. */
  reset(): void {
    this.tabs.set([]);
    this.activeKey.set(null);
    this.seeded = false;
  }

  /** Turns the terminal on or off; turning it on asks once. Returns whether the setting changed to `value`. */
  async setEnabled(value: boolean): Promise<boolean> {
    if (!this.supported) return false;
    if (value && !this.settings.terminalConfirmed()) {
      const ok = await ask(TERMINAL_CONFIRM, {
        title: "Enable terminal",
        okLabel: "Enable",
        kind: "warning",
      });
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

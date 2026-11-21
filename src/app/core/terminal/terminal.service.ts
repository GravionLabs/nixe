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

  constructor() {
    if (!this.supported) return;
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
    if (!value) this.settings.terminalVisible.set(false);
    return true;
  }
}

import { Injectable, effect, inject, signal, untracked } from "@angular/core";
import { ask } from "@tauri-apps/plugin-dialog";

import { CommandRegistry } from "../commands/command-registry";
import { backend } from "../file/backend";
import { joinPath } from "../markdown/paths";
import { SKILLS_UPDATE_PRESET, VAULT_SETUP_PRESET } from "../terminal/terminal-presets";
import { TerminalService } from "../terminal/terminal.service";
import { WorkspaceService } from "./workspace.service";

export const SKILLS_LOCK = "skills-lock.json";

export const VAULT_SETUP_OFFER =
  "The skills are updated. The core rules of CLAUDE.md are updated by “/vault-setup update”. Start it now with Claude in a new terminal tab?";

/**
 * Updates the skills of a vault that takes them from GravionLabs/skills (it has `skills-lock.json`)
 * by `npx skills update -y` in a terminal tab (#445). Nothing is committed: the files it changes are
 * ordinary changes of the Git view.
 */
@Injectable({ providedIn: "root" })
export class VaultSkillsService {
  private readonly workspace = inject(WorkspaceService);
  private readonly terminal = inject(TerminalService);
  private readonly commands = inject(CommandRegistry);

  /** The open vault has a `skills-lock.json`. */
  readonly available = signal(false);

  constructor() {
    if (!this.terminal.supported) return;
    effect(() => {
      this.workspace.vaultRoot();
      untracked(() => void this.refresh());
    });
    this.commands.register({
      id: SKILLS_UPDATE_PRESET.commandId,
      group: "Vault",
      title: SKILLS_UPDATE_PRESET.commandTitle,
      when: () => this.available(),
      run: () => this.update(),
    });
  }

  /** Looks for `skills-lock.json` in the vault root again. */
  async refresh(): Promise<void> {
    const root = this.workspace.vaultRoot();
    if (root === null) {
      this.available.set(false);
      return;
    }
    const found = await backend.isFile(joinPath(root, SKILLS_LOCK)).catch(() => false);
    if (this.workspace.vaultRoot() === root) this.available.set(found);
  }

  /** Opens a terminal tab that runs the update; once it has ended, offers the update of `CLAUDE.md`. */
  async update(): Promise<void> {
    if (!this.available()) return;
    await this.terminal.openPreset(SKILLS_UPDATE_PRESET, () => void this.offerSetup());
  }

  private async offerSetup(): Promise<void> {
    const yes = await ask(VAULT_SETUP_OFFER, {
      title: "Update vault skills",
      okLabel: "Start Claude",
      cancelLabel: "Not now",
    });
    if (yes) await this.terminal.openPreset(VAULT_SETUP_PRESET);
  }
}

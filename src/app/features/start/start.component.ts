import { Component, computed, inject, output } from "@angular/core";

import { CommandRegistry } from "../../core/commands/command-registry";
import { ShortcutService } from "../../core/commands/shortcut.service";
import { DocumentService } from "../../core/file/document.service";
import { basename, joinPath } from "../../core/markdown/paths";
import { SettingsService } from "../../core/settings/settings.service";
import { fileLabel } from "../../core/switcher/fuzzy";
import { SwitcherService } from "../../core/switcher/switcher.service";
import { WorkspaceService } from "../../core/workspace/workspace.service";
import { missingMessage } from "../../core/workspace/recent-picker.service";

const MAX_NOTES = 8;
const MAX_VAULTS = 8;

interface StartAction {
  readonly id: string;
  readonly label: string;
  readonly primary?: boolean;
}

const NO_VAULT_ACTIONS: readonly StartAction[] = [
  { id: "open-folder", label: "Open folder", primary: true },
  { id: "clone-vault", label: "Clone vault" },
  { id: "open-file", label: "Open file" },
];

const VAULT_ACTIONS: readonly StartAction[] = [
  { id: "daily-note", label: "Open the daily note", primary: true },
  { id: "new-note", label: "New note" },
  { id: "quick-switcher", label: "Quick switcher" },
];

/** The page of the empty tab: the ways to start, the recent vaults or the recent notes. */
@Component({
  selector: "app-start",
  templateUrl: "./start.component.html",
  styleUrl: "./start.component.css",
})
export class StartComponent {
  private readonly commands = inject(CommandRegistry);
  private readonly shortcuts = inject(ShortcutService);
  private readonly settings = inject(SettingsService);
  private readonly workspace = inject(WorkspaceService);
  private readonly switcher = inject(SwitcherService);
  private readonly doc = inject(DocumentService);

  /** A message for the user, for example a vault that is gone or a note that cannot be opened. */
  readonly error = output<string>();

  protected readonly inVault = computed(() => this.workspace.vaultRoot() !== null);

  protected readonly actions = computed(() =>
    (this.inVault() ? VAULT_ACTIONS : NO_VAULT_ACTIONS).map((action) => ({
      ...action,
      shortcut: this.shortcuts.display(action.id),
    })),
  );

  protected readonly notes = computed(() =>
    this.switcher
      .recentNotes()
      .slice(0, MAX_NOTES)
      .map((path) => ({ path, label: fileLabel(path) })),
  );

  protected readonly vaults = computed(() =>
    this.settings
      .recentVaults()
      .slice(0, MAX_VAULTS)
      .map((path) => ({ path, name: basename(path) })),
  );

  protected run(id: string): void {
    this.commands.execute(id);
  }

  protected async openNote(relative: string): Promise<void> {
    const root = this.workspace.vaultRoot();
    if (root === null) return;
    try {
      await this.doc.open(joinPath(root, relative));
    } catch (err) {
      this.error.emit(String(err));
    }
  }

  protected async openVault(path: string): Promise<void> {
    try {
      if (!(await this.workspace.openRecent(path))) this.error.emit(missingMessage([path]));
    } catch (err) {
      this.error.emit(String(err));
    }
  }
}

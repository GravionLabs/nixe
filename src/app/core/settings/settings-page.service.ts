import { Injectable, computed, inject, signal } from "@angular/core";

import { AppearanceService } from "../appearance/appearance.service";
import { CommandRegistry } from "../commands/command-registry";
import type { ObsidianSetting } from "../file/backend";
import { backend } from "../file/backend";
import { GitService } from "../git/git.service";
import { WorkspaceService } from "../workspace/workspace.service";
import { UpdateService } from "../updater/update.service";
import { builtinSections } from "./builtin-sections";
import { SettingsRegistry, filterSections } from "./settings-registry";
import { SettingsService } from "./settings.service";

/** State of the settings page: the search field and the Obsidian settings of the vault. */
@Injectable({ providedIn: "root" })
export class SettingsPageService {
  private readonly registry = inject(SettingsRegistry);
  private readonly workspace = inject(WorkspaceService);

  readonly query = signal("");
  /** Section shown when no search is active. */
  readonly selectedId = signal("general");
  private readonly obsidian = signal<readonly ObsidianSetting[] | null>(null);

  /** The sections with the settings that match the search field. */
  readonly sections = computed(() => filterSections(this.registry.shown(), this.query()));

  constructor() {
    const commands = inject(CommandRegistry);
    const updater = inject(UpdateService);
    const appearance = inject(AppearanceService);
    const git = inject(GitService);
    const sections = builtinSections({
      appearance: {
        themes: () => appearance.themes(),
        snippets: () => appearance.snippets(),
        folder: () => appearance.folder(),
      },
      git: {
        tokenStored: () => git.tokenStored(),
        tokenPrompt: () => git.tokenPrompt()?.reason ?? null,
        saveToken: (token) => git.saveToken(token),
        deleteToken: () => git.deleteToken(),
        cancelTokenPrompt: () => git.cancelTokenPrompt(),
      },
      settings: inject(SettingsService),
      obsidian: () => this.obsidian(),
      commands: () => commands.all(),
      version: () => updater.version(),
    });
    for (const section of sections) this.registry.register(section);
  }

  /** The sections to list: all matches while searching, else the selected one. */
  readonly listed = computed(() => {
    const sections = this.sections();
    if (this.query().trim()) return sections;
    return sections.filter((s) => s.id === this.selectedId());
  });

  /** Resets the search and reads the Obsidian settings; the tab itself is opened by `TabsService`. */
  async open(): Promise<void> {
    this.query.set("");
    await this.refreshObsidian();
  }

  select(id: string): void {
    this.query.set("");
    this.selectedId.set(id);
  }

  /** Reads `.obsidian/` of the open vault again; no vault open shows nothing. */
  async refreshObsidian(): Promise<void> {
    if (this.workspace.vaultRoot() === null) {
      this.obsidian.set(null);
      return;
    }
    this.obsidian.set(await backend.obsidianSettings().catch(() => null));
  }
}

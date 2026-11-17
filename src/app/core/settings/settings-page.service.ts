import { Injectable, computed, inject, signal } from "@angular/core";

import { CommandRegistry } from "../commands/command-registry";
import { ObsidianSetting, backend } from "../file/backend";
import { WorkspaceService } from "../workspace/workspace.service";
import { builtinSections } from "./builtin-sections";
import { SettingsRegistry, filterSections } from "./settings-registry";
import { SettingsService } from "./settings.service";

/** State of the settings page: visibility, the search field and the Obsidian settings of the vault. */
@Injectable({ providedIn: "root" })
export class SettingsPageService {
  private readonly registry = inject(SettingsRegistry);
  private readonly workspace = inject(WorkspaceService);

  readonly visible = signal(false);
  readonly query = signal("");
  /** Section shown when no search is active. */
  readonly selectedId = signal("general");
  private readonly obsidian = signal<readonly ObsidianSetting[] | null>(null);

  /** The sections with the settings that match the search field. */
  readonly sections = computed(() => filterSections(this.registry.shown(), this.query()));

  constructor() {
    const commands = inject(CommandRegistry);
    const sections = builtinSections({
      settings: inject(SettingsService),
      obsidian: () => this.obsidian(),
      commands: () => commands.all(),
    });
    for (const section of sections) this.registry.register(section);
  }

  /** The sections to list: all matches while searching, else the selected one. */
  readonly listed = computed(() => {
    const sections = this.sections();
    if (this.query().trim()) return sections;
    return sections.filter((s) => s.id === this.selectedId());
  });

  async open(): Promise<void> {
    this.query.set("");
    this.visible.set(true);
    await this.refreshObsidian();
  }

  close(): void {
    this.visible.set(false);
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

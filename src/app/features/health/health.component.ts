import { Component, effect, inject, output, untracked } from "@angular/core";
import { HxButton, HxField, HxInput, HxList, HxListRow } from "@gravionlabs/helix-ui";

import { HealthService } from "../../core/index/health.service";
import { joinPath } from "../../core/markdown/paths";
import { SettingsService } from "../../core/settings/settings.service";
import { TabsService } from "../../core/tabs/tabs.service";
import { WorkspaceService } from "../../core/workspace/workspace.service";

/** The vault health tab: the problems of the vault, each entry opens the note. */
@Component({
  selector: "app-health",
  imports: [HxButton, HxField, HxInput, HxList, HxListRow],
  templateUrl: "./health.component.html",
  styleUrl: "./health.component.css",
})
export class HealthComponent {
  protected readonly health = inject(HealthService);
  protected readonly settings = inject(SettingsService);
  private readonly tabs = inject(TabsService);
  private readonly workspace = inject(WorkspaceService);

  readonly failed = output<string>();

  constructor() {
    effect(() => {
      this.health.key();
      untracked(() => void this.health.refresh());
    });
  }

  protected onExclude(event: Event): void {
    this.health.setExcluded((event.target as HTMLInputElement).value);
  }

  protected async checkLinks(force = false): Promise<void> {
    const root = this.workspace.vaultRoot();
    if (root) await this.health.checkLinks(root, force);
  }

  protected async open(rel: string, line: number | null = null): Promise<void> {
    const root = this.workspace.vaultRoot();
    if (!root) return;
    try {
      // The health tab stays: the note opens in a tab of its own.
      await this.tabs.openInNewTab(joinPath(root, rel), { line });
    } catch (err) {
      this.failed.emit(String(err));
    }
  }
}

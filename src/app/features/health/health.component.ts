import { Component, effect, inject, output, untracked } from "@angular/core";

import { DocumentService } from "../../core/file/document.service";
import { HealthService } from "../../core/index/health.service";
import { joinPath } from "../../core/markdown/paths";
import { SettingsService } from "../../core/settings/settings.service";
import { WorkspaceService } from "../../core/workspace/workspace.service";

/** Left-hand panel: the problems of the vault, each entry opens the note. */
@Component({
  selector: "app-health",
  templateUrl: "./health.component.html",
  styleUrl: "./health.component.css",
})
export class HealthComponent {
  protected readonly health = inject(HealthService);
  protected readonly settings = inject(SettingsService);
  private readonly doc = inject(DocumentService);
  private readonly workspace = inject(WorkspaceService);

  readonly error = output<string>();

  constructor() {
    effect(() => {
      this.health.key();
      untracked(() => void this.health.refresh());
    });
  }

  protected onExclude(event: Event): void {
    this.health.setExcluded((event.target as HTMLInputElement).value);
  }

  protected async open(rel: string, line: number | null = null): Promise<void> {
    const root = this.workspace.vaultRoot();
    if (!root) return;
    try {
      await this.doc.open(joinPath(root, rel), { line });
    } catch (err) {
      this.error.emit(String(err));
    }
  }
}

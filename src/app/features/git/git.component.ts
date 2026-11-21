import { Component, inject, output } from "@angular/core";

import { clampMinutes } from "../../core/git/auto-sync";
import { DocumentService } from "../../core/file/document.service";
import { GitService } from "../../core/git/git.service";
import { joinPath } from "../../core/markdown/paths";
import { SettingsService } from "../../core/settings/settings.service";
import { WorkspaceService } from "../../core/workspace/workspace.service";
import { EmptyStateComponent } from "../../shared/panel/empty-state.component";
import { NoteRowComponent } from "../../shared/panel/note-row.component";
import { PanelSectionComponent } from "../../shared/panel/panel-section.component";
import { ChangesComponent } from "../changes/changes.component";
import { ReviewComponent } from "../review/review.component";

/** Left-hand panel: the changed notes of the vault and a commit form. */
@Component({
  selector: "app-git",
  imports: [
    ChangesComponent,
    ReviewComponent,
    PanelSectionComponent,
    NoteRowComponent,
    EmptyStateComponent,
  ],
  templateUrl: "./git.component.html",
  styleUrl: "./git.component.css",
})
export class GitComponent {
  protected readonly git = inject(GitService);
  protected readonly settings = inject(SettingsService);
  private readonly doc = inject(DocumentService);
  private readonly workspace = inject(WorkspaceService);

  readonly failed = output<string>();
  readonly committed = output<void>();

  protected setMinutes(input: HTMLInputElement): void {
    const minutes = clampMinutes(input.valueAsNumber);
    this.settings.autoSyncMinutes.set(minutes);
    input.value = String(minutes);
  }

  protected async open(rel: string): Promise<void> {
    const root = this.workspace.vaultRoot();
    if (!root) return;
    try {
      await this.doc.open(joinPath(root, rel));
    } catch (err) {
      this.failed.emit(String(err));
    }
  }

  protected async saveToken(input: HTMLInputElement): Promise<void> {
    try {
      await this.git.saveToken(input.value);
      input.value = "";
    } catch (err) {
      this.failed.emit(String(err));
    }
  }

  protected async deleteToken(): Promise<void> {
    try {
      await this.git.deleteToken();
    } catch (err) {
      this.failed.emit(String(err));
    }
  }

  protected async commit(event: Event, message: string): Promise<void> {
    event.preventDefault();
    try {
      await this.git.commit(message);
      const form = event.target as HTMLFormElement | null;
      form?.reset();
      this.committed.emit();
    } catch (err) {
      this.failed.emit(String(err));
    }
  }
}

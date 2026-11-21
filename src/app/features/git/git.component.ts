import { Component, inject, output } from "@angular/core";

import { clampMinutes } from "../../core/git/auto-sync";
import { CommandRegistry } from "../../core/commands/command-registry";
import { CompareService } from "../../core/compare/compare.service";
import type { GitChange } from "../../core/file/backend";
import { backend } from "../../core/file/backend";
import { DocumentService } from "../../core/file/document.service";
import { DiscardService } from "../../core/git/discard.service";
import { GitService } from "../../core/git/git.service";
import { ReviewService } from "../../core/git/review.service";
import { syncSummary } from "../../core/git/sync-summary";
import { basename, joinPath } from "../../core/markdown/paths";
import { SettingsService } from "../../core/settings/settings.service";
import { WorkspaceService } from "../../core/workspace/workspace.service";
import { EmptyStateComponent } from "../../shared/panel/empty-state.component";
import { NoteRowComponent } from "../../shared/panel/note-row.component";
import { PanelSectionComponent } from "../../shared/panel/panel-section.component";
import { ChangesComponent } from "../changes/changes.component";
import { ReviewComponent } from "../review/review.component";

/** Left-hand panel: is the vault in sync, what changed, and a box to save it. */
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
  protected readonly review = inject(ReviewService);
  private readonly discarding = inject(DiscardService);
  private readonly doc = inject(DocumentService);
  private readonly workspace = inject(WorkspaceService);
  private readonly compareView = inject(CompareService);
  private readonly commands = inject(CommandRegistry);

  readonly failed = output<string>();
  readonly committed = output<void>();

  protected summary(): string {
    const status = this.git.status();
    return status ? syncSummary(status, this.git.lastSynced(), Date.now()) : "";
  }

  protected branchTip(): string {
    const status = this.git.status();
    if (!status) return "";
    const parts = [`Branch ${status.branch ?? "none"}`];
    if (status.ahead) parts.push(`${status.ahead} to send`);
    if (status.behind) parts.push(`${status.behind} to receive`);
    return parts.join(" · ");
  }

  protected setUp(): void {
    this.commands.execute("open-settings");
  }

  protected async syncNow(): Promise<void> {
    await this.git.sync();
  }

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

  /** Asks, then takes the changes of the note back; Undo is offered afterwards. */
  protected async discard(change: GitChange): Promise<void> {
    try {
      await this.discarding.discard(change);
    } catch (err) {
      this.failed.emit(String(err));
    }
  }

  /** Opens the saved version of a changed note against its text now. */
  protected async compare(change: GitChange): Promise<void> {
    try {
      const [oldText, newText] = await Promise.all([
        change.kind === "added"
          ? Promise.resolve(null)
          : backend.gitNoteVersion(change.path, "HEAD"),
        change.kind === "deleted"
          ? Promise.resolve(null)
          : backend.gitNoteVersion(change.path, null),
      ]);
      this.compareView.open({
        path: change.path,
        title: basename(change.path).replace(/\.(md|markdown|mdown|mkd)$/i, ""),
        oldLabel: "Saved version",
        newLabel: "Now",
        oldText,
        newText,
      });
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

  protected async save(event: Event, message: string): Promise<void> {
    event.preventDefault();
    try {
      await this.git.saveAndSync(message);
      const form = event.target as HTMLFormElement | null;
      form?.reset();
      this.committed.emit();
    } catch (err) {
      this.failed.emit(String(err));
    }
  }
}

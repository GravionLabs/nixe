import { Component, inject, output } from "@angular/core";
import {
  HxButton,
  HxCheckbox,
  HxField,
  HxInput,
  HxList,
  HxListRow,
  HxTooltip,
} from "@gravionlabs/helix-ui";

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
import { SettingsPageService } from "../../core/settings/settings-page.service";
import { WorkspaceService } from "../../core/workspace/workspace.service";
import { EmptyStateComponent } from "../../shared/panel/empty-state.component";
import { noteLabel } from "../../shared/panel/note-label";
import { NoteRowComponent } from "../../shared/panel/note-row.component";
import { NoteTitleComponent } from "../../shared/panel/note-title.component";
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
    NoteTitleComponent,
    HxButton,
    HxCheckbox,
    HxField,
    HxInput,
    HxList,
    HxListRow,
    HxTooltip,
    EmptyStateComponent,
  ],
  templateUrl: "./git.component.html",
  styleUrl: "./git.component.css",
})
export class GitComponent {
  protected readonly git = inject(GitService);
  private readonly settingsPage = inject(SettingsPageService);
  protected readonly review = inject(ReviewService);
  private readonly discarding = inject(DiscardService);
  private readonly doc = inject(DocumentService);
  private readonly workspace = inject(WorkspaceService);
  private readonly compareView = inject(CompareService);
  private readonly commands = inject(CommandRegistry);

  readonly failed = output<string>();
  readonly committed = output<void>();

  protected titleOf(path: string): string {
    return noteLabel(path).title;
  }

  /** "Save 2 of 5" when only some changes are checked; else Save, or Save and sync with a remote. */
  protected saveLabel(): string {
    const status = this.git.status();
    if (this.git.selection() === "some" && status) {
      return `Save ${this.git.selected().length} of ${status.changes.length}`;
    }
    return status?.hasRemote ? "Save and sync" : "Save";
  }

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

  /** One line when the token is missing or was rejected; empty when there is nothing to say. */
  protected tokenNotice(): string {
    const prompt = this.git.tokenPrompt();
    if (prompt) {
      return prompt.reason === "failed"
        ? "GitHub rejected the access token."
        : "GitHub needs an access token.";
    }
    return this.git.status()?.hasRemote && !this.git.tokenStored()
      ? "No access token stored yet."
      : "";
  }

  protected openSyncSettings(): void {
    this.settingsPage.select("sync");
    this.commands.execute("open-settings");
  }

  protected setUp(): void {
    this.commands.execute("open-settings");
  }

  protected async addIgnores(): Promise<void> {
    try {
      await this.git.addMissingIgnores();
    } catch (err) {
      this.failed.emit(String(err));
    }
  }

  protected async dismissIgnoreHint(): Promise<void> {
    try {
      await this.git.dismissIgnoreHint();
    } catch (err) {
      this.failed.emit(String(err));
    }
  }

  protected async syncNow(): Promise<void> {
    await this.git.sync();
  }

  /** The row of the open note. */
  protected isCurrent(rel: string): boolean {
    const root = this.workspace.vaultRoot();
    return root !== null && this.doc.path() === joinPath(root, rel);
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

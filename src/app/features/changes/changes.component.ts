import { Component, inject } from "@angular/core";

import type { GitChange, VaultCommit } from "../../core/file/backend";
import { DocumentService } from "../../core/file/document.service";
import { ChangesService, versionDate } from "../../core/git/changes.service";
import { joinPath } from "../../core/markdown/paths";
import { NoteRowComponent } from "../../shared/panel/note-row.component";
import { PanelSectionComponent } from "../../shared/panel/panel-section.component";
import { WorkspaceService } from "../../core/workspace/workspace.service";

/** The notes that changed between two points of the history, each with its diff (#107). */
@Component({
  selector: "app-changes",
  imports: [PanelSectionComponent, NoteRowComponent],
  templateUrl: "./changes.component.html",
  styleUrl: "./changes.component.css",
})
export class ChangesComponent {
  protected readonly changes = inject(ChangesService);
  private readonly doc = inject(DocumentService);
  private readonly workspace = inject(WorkspaceService);

  protected readonly versionDate = versionDate;

  protected pick(value: string): void {
    if (value === "sync") void this.changes.showSync();
    else if (value === "yesterday") void this.changes.showYesterday();
    else if (value === "week") void this.changes.showWeek();
    else void this.changes.chooseVersion();
  }

  protected pickVersion(id: string): void {
    const commit = this.changes.versions().find((v) => v.id === id);
    if (commit) void this.changes.showVersion(commit);
  }

  protected versionLabel(v: VaultCommit): string {
    const by = v.author ? ` · ${v.author}` : "";
    return `${versionDate(v.time)} · ${v.message || "(no message)"}${by}`;
  }

  protected async open(change: GitChange): Promise<void> {
    const root = this.workspace.vaultRoot();
    if (root && change.kind !== "deleted") await this.doc.open(joinPath(root, change.path));
  }
}

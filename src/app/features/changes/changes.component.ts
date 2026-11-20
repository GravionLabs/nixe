import { Component, computed, inject } from "@angular/core";

import { GitChange } from "../../core/file/backend";
import { DocumentService } from "../../core/file/document.service";
import { ChangesService } from "../../core/git/changes.service";
import { diffLines, diffStat } from "../../core/git/line-diff";
import { joinPath } from "../../core/markdown/paths";
import { WorkspaceService } from "../../core/workspace/workspace.service";

/** The notes that changed between two points of the history, each with its diff (#107). */
@Component({
  selector: "app-changes",
  templateUrl: "./changes.component.html",
  styleUrl: "./changes.component.css",
})
export class ChangesComponent {
  protected readonly changes = inject(ChangesService);
  private readonly doc = inject(DocumentService);
  private readonly workspace = inject(WorkspaceService);

  protected readonly rows = computed(() => {
    const d = this.changes.diff();
    return d ? diffLines(d.oldText, d.newText) : [];
  });
  protected readonly stat = computed(() => diffStat(this.rows()));

  protected letter(kind: GitChange["kind"]): string {
    return kind === "added" ? "A" : kind === "deleted" ? "D" : "M";
  }

  protected async open(change: GitChange): Promise<void> {
    const root = this.workspace.vaultRoot();
    if (root && change.kind !== "deleted") await this.doc.open(joinPath(root, change.path));
  }
}

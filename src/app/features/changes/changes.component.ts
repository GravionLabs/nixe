import { Component, computed, inject } from "@angular/core";
import { HxButton, HxField, HxList, HxListRow, HxSelect, HxTooltip } from "@gravionlabs/helix-ui";

import type { GitChange, VaultCommit } from "../../core/file/backend";
import { DocumentService } from "../../core/file/document.service";
import type { RangeKind } from "../../core/git/changes.service";
import { ChangesService, versionDate } from "../../core/git/changes.service";
import { joinPath } from "../../core/markdown/paths";
import { noteLabel } from "../../shared/panel/note-label";
import { NoteRowComponent } from "../../shared/panel/note-row.component";
import { NoteTitleComponent } from "../../shared/panel/note-title.component";
import { PanelSectionComponent } from "../../shared/panel/panel-section.component";
import { WorkspaceService } from "../../core/workspace/workspace.service";

const RANGES: readonly { value: RangeKind; label: string }[] = [
  { value: "sync", label: "Last sync" },
  { value: "yesterday", label: "Yesterday" },
  { value: "week", label: "Last week" },
  { value: "commit", label: "Choose a version…" },
];

/** The notes that changed between two points of the history, each with its diff (#107). */
@Component({
  selector: "app-changes",
  imports: [
    PanelSectionComponent,
    NoteRowComponent,
    NoteTitleComponent,
    HxButton,
    HxField,
    HxList,
    HxListRow,
    HxSelect,
    HxTooltip,
  ],
  templateUrl: "./changes.component.html",
  styleUrl: "./changes.component.css",
})
export class ChangesComponent {
  protected readonly changes = inject(ChangesService);
  private readonly doc = inject(DocumentService);
  private readonly workspace = inject(WorkspaceService);

  protected readonly ranges = RANGES;
  protected readonly versionOptions = computed(() =>
    this.changes.versions().map((v) => ({ value: v.id, label: this.versionLabel(v) })),
  );

  protected pick(value: RangeKind | null): void {
    if (value === "sync") void this.changes.showSync();
    else if (value === "yesterday") void this.changes.showYesterday();
    else if (value === "week") void this.changes.showWeek();
    else if (value === "commit") void this.changes.chooseVersion();
  }

  protected pickVersion(id: string | null): void {
    const commit = this.changes.versions().find((v) => v.id === id);
    if (commit) void this.changes.showVersion(commit);
  }

  protected titleOf(path: string): string {
    return noteLabel(path).title;
  }

  private versionLabel(v: VaultCommit): string {
    const by = v.author ? ` · ${v.author}` : "";
    return `${versionDate(v.time)} · ${v.message || "(no message)"}${by}`;
  }

  /** The row of the open note. */
  protected isCurrent(rel: string): boolean {
    const root = this.workspace.vaultRoot();
    return root !== null && this.doc.path() === joinPath(root, rel);
  }

  protected async open(change: GitChange): Promise<void> {
    const root = this.workspace.vaultRoot();
    if (root && change.kind !== "deleted") await this.doc.open(joinPath(root, change.path));
  }
}

import { Component, computed, inject, signal } from "@angular/core";

import type { ReviewHunk } from "../../core/file/backend";
import { DocumentService } from "../../core/file/document.service";
import { diffLines, diffStat } from "../../core/git/line-diff";
import { ReviewService } from "../../core/git/review.service";
import { DiffComponent } from "../../shared/diff/diff.component";
import { EmptyStateComponent } from "../../shared/panel/empty-state.component";
import { NoteRowComponent } from "../../shared/panel/note-row.component";
import { PanelSectionComponent } from "../../shared/panel/panel-section.component";
import { formatCommitTime } from "../history/history.component";

/** The branches that wait for review and, per branch, its changed notes with the diff (#108). */
@Component({
  selector: "app-review",
  imports: [DiffComponent, PanelSectionComponent, NoteRowComponent, EmptyStateComponent],
  templateUrl: "./review.component.html",
  styleUrl: "./review.component.css",
})
export class ReviewComponent {
  protected readonly review = inject(ReviewService);
  private readonly doc = inject(DocumentService);

  protected readonly mode = signal<"hunks" | "source" | "rendered">("hunks");
  /** The finish button asked and waits for the user to confirm the deletion of the branch. */
  protected readonly confirming = signal(false);
  /** The hunk whose text is being edited, as `path#index`. */
  protected readonly editing = signal<string | null>(null);
  protected readonly time = formatCommitTime;

  protected readonly stat = computed(() => {
    const d = this.review.diff();
    return diffStat(d ? diffLines(d.oldText, d.newText) : []);
  });

  protected readonly selectedHunks = computed(() => {
    const path = this.review.selected();
    return path ? (this.review.hunks()[path] ?? []) : [];
  });

  protected edit(path: string, hunk: ReviewHunk): void {
    this.editing.set(`${path}#${hunk.index}`);
  }

  protected saveEdit(path: string, index: number, text: string): void {
    this.review.editHunk(path, index, text);
    this.editing.set(null);
  }

  protected async finish(): Promise<void> {
    this.confirming.set(false);
    await this.review.finish();
  }
}

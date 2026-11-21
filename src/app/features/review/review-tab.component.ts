import { Component, computed, effect, inject, signal, untracked } from "@angular/core";

import type { ReviewHunk } from "../../core/file/backend";
import { diffLines, diffStat } from "../../core/git/line-diff";
import { ReviewService } from "../../core/git/review.service";
import { CURRENT_TAB, TabsService } from "../../core/tabs/tabs.service";
import { DiffComponent } from "../../shared/diff/diff.component";
import { EmptyStateComponent } from "../../shared/panel/empty-state.component";
import { NoteRowComponent } from "../../shared/panel/note-row.component";

/**
 * The review of one suggestion in the main area (#322): the list of its notes and the compare
 * view of the selected note with its sections, the conflicts and the finish button.
 */
@Component({
  selector: "app-review-tab",
  imports: [DiffComponent, NoteRowComponent, EmptyStateComponent],
  templateUrl: "./review-tab.component.html",
  styleUrl: "./review-tab.component.css",
})
export class ReviewTabComponent {
  protected readonly review = inject(ReviewService);
  private readonly tabs = inject(TabsService);
  private readonly tab = inject(CURRENT_TAB);

  protected readonly mode = signal<"sections" | "source" | "rendered">("sections");
  /** The finish button asked and waits for the user to confirm. */
  protected readonly confirming = signal(false);
  /** The section whose text is being edited, as `path#index`. */
  protected readonly editing = signal<string | null>(null);

  protected readonly stat = computed(() => {
    const d = this.review.diff();
    return diffStat(d ? diffLines(d.oldText, d.newText) : []);
  });

  protected readonly sections = computed(() => {
    const path = this.review.selected();
    return path ? (this.review.hunks()[path] ?? []) : [];
  });

  constructor() {
    // The first note is shown as soon as the list is there.
    effect(() => {
      const changes = this.review.changes();
      if (changes.length > 0 && this.review.selected() === null)
        untracked(() => void this.review.select(changes[0]));
    });
  }

  protected edit(path: string, section: ReviewHunk): void {
    this.editing.set(`${path}#${section.index}`);
  }

  protected saveEdit(path: string, index: number, text: string): void {
    this.review.editHunk(path, index, text);
    this.editing.set(null);
  }

  protected async finish(): Promise<void> {
    this.confirming.set(false);
    await this.review.finish();
    if (this.review.open() !== null) return;
    // The suggestion is taken over and gone: its tab goes with it.
    const pane = this.tabs.panes().find((p) => p.tabs.includes(this.tab));
    if (pane) this.tabs.closeTab(pane.id, this.tab.id);
  }
}

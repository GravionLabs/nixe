import { Component, computed, inject, signal } from "@angular/core";

import type { GitChange, ReviewHunk } from "../../core/file/backend";
import { DocumentService } from "../../core/file/document.service";
import { diffLines, diffStat } from "../../core/git/line-diff";
import { ReviewService } from "../../core/git/review.service";
import { MarkdownService } from "../../core/markdown/markdown.service";
import { WorkspaceService } from "../../core/workspace/workspace.service";
import { formatCommitTime } from "../history/history.component";

/** The branches that wait for review and, per branch, its changed notes with the diff (#108). */
@Component({
  selector: "app-review",
  templateUrl: "./review.component.html",
  styleUrl: "./review.component.css",
})
export class ReviewComponent {
  protected readonly review = inject(ReviewService);
  private readonly markdown = inject(MarkdownService);
  private readonly workspace = inject(WorkspaceService);
  private readonly doc = inject(DocumentService);

  protected readonly mode = signal<"hunks" | "source" | "rendered">("hunks");
  /** The finish button asked and waits for the user to confirm the deletion of the branch. */
  protected readonly confirming = signal(false);
  /** The hunk whose text is being edited, as `path#index`. */
  protected readonly editing = signal<string | null>(null);
  protected readonly time = formatCommitTime;

  protected readonly rows = computed(() => {
    const d = this.review.diff();
    return d ? diffLines(d.oldText, d.newText) : [];
  });
  protected readonly stat = computed(() => diffStat(this.rows()));
  protected readonly rendered = computed(() => {
    const d = this.review.diff();
    if (!d) return null;
    const ctx = {
      filePath: null,
      wikiRoot: null,
      math: false,
      vaultRoot: this.workspace.vaultRoot(),
    };
    return { old: this.markdown.render(d.oldText, ctx), new: this.markdown.render(d.newText, ctx) };
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

  protected letter(kind: GitChange["kind"]): string {
    return kind === "added" ? "A" : kind === "deleted" ? "D" : "M";
  }
}

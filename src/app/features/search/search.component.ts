import { Component, ElementRef, effect, inject, output, untracked, viewChild } from "@angular/core";

import { BookmarksService } from "../../core/bookmarks/bookmarks.service";
import { SearchHit, SearchSnippet } from "../../core/file/backend";
import { DocumentService } from "../../core/file/document.service";
import { SearchService, segments } from "../../core/index/search.service";
import { joinPath } from "../../core/markdown/paths";
import { WorkspaceService } from "../../core/workspace/workspace.service";

/** Left-hand search panel: results grouped by note, with highlighted snippets. */
@Component({
  selector: "app-search",
  templateUrl: "./search.component.html",
  styleUrl: "./search.component.css",
})
export class SearchComponent {
  protected readonly search = inject(SearchService);
  private readonly doc = inject(DocumentService);
  private readonly workspace = inject(WorkspaceService);
  private readonly bookmarks = inject(BookmarksService);

  readonly error = output<string>();
  protected readonly segments = segments;
  private readonly input = viewChild<ElementRef<HTMLInputElement>>("input");

  constructor() {
    // Results follow the index: they are read again when it finishes or applies changes.
    effect(() => {
      this.search.key();
      untracked(() => void this.search.refresh());
    });
    // Showing the view puts the cursor into the field.
    effect(() => {
      const el = this.input()?.nativeElement;
      if (el) el.focus();
    });
  }

  protected bookmarkSearch(): void {
    this.bookmarks.bookmarkSearch();
  }

  protected onInput(event: Event): void {
    void this.search.setQuery((event.target as HTMLInputElement).value);
  }

  protected openHit(hit: SearchHit, snippet?: SearchSnippet): Promise<void> {
    return this.open(hit.path, snippet?.line ?? null);
  }

  private async open(rel: string, line: number | null): Promise<void> {
    const root = this.workspace.vaultRoot();
    if (!root) return;
    try {
      await this.doc.open(joinPath(root, rel), { line });
    } catch (err) {
      this.error.emit(String(err));
    }
  }
}

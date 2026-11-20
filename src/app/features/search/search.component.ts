import { Component, ElementRef, computed, effect, inject, output, signal, untracked, viewChild } from "@angular/core";

import { BookmarksService } from "../../core/bookmarks/bookmarks.service";
import { SearchHit, SearchSnippet } from "../../core/file/backend";
import { DocumentService } from "../../core/file/document.service";
import { ReplaceService } from "../../core/index/replace.service";
import { SEARCH_SORTS, SearchService, SearchSort, segments, sortHits, withOperator } from "../../core/index/search.service";
import { joinPath } from "../../core/markdown/paths";
import { WorkspaceService } from "../../core/workspace/workspace.service";

const SORT_KEY = "nixe.search.sort";

/** The operators the help lists: what is inserted, and what it does. */
export const SEARCH_OPERATORS = [
  { insert: "tag:#", text: "notes with a tag, nested tags included" },
  { insert: "path:", text: "notes in a folder, for example path:work/" },
  { insert: '""', text: "an exact phrase" },
] as const;

function storedSort(): SearchSort {
  try {
    const value = localStorage.getItem(SORT_KEY);
    return SEARCH_SORTS.find((s) => s === value) ?? "relevance";
  } catch {
    return "relevance";
  }
}

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
  protected readonly replace = inject(ReplaceService);
  private readonly bookmarks = inject(BookmarksService);

  readonly error = output<string>();
  protected readonly segments = segments;
  private readonly input = viewChild<ElementRef<HTMLInputElement>>("input");
  protected readonly operators = SEARCH_OPERATORS;
  protected readonly sorts = SEARCH_SORTS;
  protected readonly sort = signal<SearchSort>(storedSort());
  protected readonly helpOpen = signal(false);
  /** Paths of the notes whose snippets are folded away. */
  protected readonly collapsed = signal<ReadonlySet<string>>(new Set());
  protected readonly sorted = computed(() => sortHits(this.search.hits(), this.sort()));
  protected readonly allCollapsed = computed(() => {
    const hits = this.search.hits();
    return hits.length > 0 && hits.every((h) => this.collapsed().has(h.path));
  });

  constructor() {
    // Results follow the index: they are read again when it finishes or applies changes.
    effect(() => {
      this.search.key();
      untracked(() => void this.search.refresh());
    });
    // The diff follows the find text, the replacement and the options, and the index.
    effect(() => {
      this.replace.enabled();
      this.replace.replacement();
      this.replace.regex();
      this.replace.caseSensitive();
      this.replace.wholeWord();
      this.search.key();
      const query = this.search.query().trim();
      untracked(() => void this.replace.refresh(query));
    });
    // Showing the view puts the cursor into the field.
    effect(() => {
      const el = this.input()?.nativeElement;
      if (el) el.focus();
    });
  }

  protected setSort(event: Event): void {
    const value = (event.target as HTMLSelectElement).value as SearchSort;
    if (!SEARCH_SORTS.includes(value)) return;
    this.sort.set(value);
    try {
      localStorage.setItem(SORT_KEY, value);
    } catch {
      // The choice then only lasts for this session.
    }
  }

  protected toggleNote(path: string): void {
    const next = new Set(this.collapsed());
    if (!next.delete(path)) next.add(path);
    this.collapsed.set(next);
  }

  protected toggleAll(): void {
    this.collapsed.set(this.allCollapsed() ? new Set() : new Set(this.search.hits().map((h) => h.path)));
  }

  protected insertOperator(operator: string): void {
    void this.search.setQuery(withOperator(this.search.query(), operator));
    this.input()?.nativeElement.focus();
  }

  protected countLabel(): string {
    const hits = this.search.hits();
    const count = hits.reduce((n, h) => n + Math.max(h.snippets.length, 1), 0);
    return `${count} ${count === 1 ? "result" : "results"} in ${hits.length} ${hits.length === 1 ? "note" : "notes"}`;
  }

  protected bookmarkSearch(): void {
    this.bookmarks.bookmarkSearch();
  }

  protected onReplacement(event: Event): void {
    this.replace.replacement.set((event.target as HTMLInputElement).value);
  }

  protected async applyReplace(): Promise<void> {
    try {
      await this.replace.apply(this.search.query().trim());
    } catch (err) {
      this.error.emit(String(err));
    }
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

import { Component, computed, inject, signal } from "@angular/core";
import { HxButton, HxInput, HxList, HxListRow, HxTooltip } from "@gravionlabs/helix-ui";

import type { Bookmark, ItemPath } from "../../core/bookmarks/bookmarks-core";
import { isFile, isGroup, isSearch, labelOf } from "../../core/bookmarks/bookmarks-core";
import { BookmarksService } from "../../core/bookmarks/bookmarks.service";
import { DocumentService } from "../../core/file/document.service";
import { SearchService } from "../../core/index/search.service";
import { ShellService } from "../../core/shell/shell.service";

/** One line of the panel: a bookmark with its position and depth. */
export interface BookmarkRow {
  path: ItemPath;
  depth: number;
  bookmark: Bookmark;
  kind: "note" | "heading" | "search" | "group" | "other";
}

/** The rows of a bookmark tree in display order. */
export function bookmarkRows(items: readonly Bookmark[], parent: ItemPath = []): BookmarkRow[] {
  return items.flatMap((bookmark, i) => {
    const path = [...parent, i];
    const kind: BookmarkRow["kind"] = isGroup(bookmark)
      ? "group"
      : isSearch(bookmark)
        ? "search"
        : isFile(bookmark)
          ? bookmark.subpath
            ? "heading"
            : "note"
          : "other";
    const row: BookmarkRow = { path, depth: parent.length, bookmark, kind };
    return isGroup(bookmark) ? [row, ...bookmarkRows(bookmark.items, path)] : [row];
  });
}

const ICONS: Record<BookmarkRow["kind"], string> = {
  note: "📄",
  heading: "#",
  search: "🔍",
  group: "📁",
  other: "•",
};

/** Sidebar: the bookmarks of the vault; drag to reorder or to move into a group. */
@Component({
  selector: "app-bookmarks",
  imports: [HxButton, HxInput, HxList, HxListRow, HxTooltip],
  templateUrl: "./bookmarks.component.html",
  styles: `
    :host {
      display: flex;
      flex-direction: column;
      flex: 1;
      height: 100%;
      min-height: 0;
      min-width: 0;
      overflow-y: auto;
      background: var(--h-surface-frame);
      color: var(--h-text-color);
      font-size: 13px;
    }
    header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      height: 34px;
      padding: 0 12px;
      border-bottom: 1px solid var(--h-content-border-color);
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      color: var(--h-text-muted-color);
    }
    ul {
      list-style: none;
      margin: 0;
      padding: 4px 0;
      flex: 1;
    }
    li {
      display: flex;
      align-items: center;
      gap: 6px;
      padding-right: 8px;
      min-height: 26px;
    }
    .status {
      margin: 8px 12px;
      color: var(--h-text-muted-color);
    }
    .label {
      flex: 1;
    }
    .actions {
      visibility: hidden;
    }
    li:hover .actions,
    li:focus-within .actions {
      visibility: visible;
    }
    .rename {
      flex: 1;
      min-width: 0;
    }
    li[data-kind="group"] .hx-list-row-label {
      font-weight: 600;
    }
  `,
})
export class BookmarksComponent {
  protected readonly bookmarks = inject(BookmarksService);
  private readonly search = inject(SearchService);
  private readonly shell = inject(ShellService);
  private readonly doc = inject(DocumentService);

  protected readonly rows = computed(() => bookmarkRows(this.bookmarks.items()));
  protected readonly dragging = signal<ItemPath | null>(null);
  protected readonly editing = signal<ItemPath | null>(null);

  protected icon(row: BookmarkRow): string {
    return ICONS[row.kind];
  }

  protected label(row: BookmarkRow): string {
    return labelOf(row.bookmark);
  }

  /** A bookmark of the open note itself; one of a heading or a block in it is not. */
  protected isCurrent(row: BookmarkRow): boolean {
    if (row.kind !== "note") return false;
    const open = this.bookmarks.relative(this.doc.path());
    return open !== null && open === (row.bookmark as { path: string }).path;
  }

  protected open(row: BookmarkRow, pin = false): void {
    if (row.kind === "group") return;
    void this.bookmarks
      .open(
        row.bookmark,
        (query) => {
          this.shell.show("search");
          void this.search.setQuery(query);
        },
        pin,
      )
      .catch((err) => this.bookmarks.notice.set(String(err)));
  }

  protected rename(row: BookmarkRow): void {
    if (row.kind === "group") this.editing.set(row.path);
    else this.open(row, true);
  }

  protected commit(row: BookmarkRow, title: string): void {
    if (this.editing() === null) return;
    this.editing.set(null);
    if (title.trim()) this.bookmarks.renameGroup(row.path, title);
  }

  /** Dropped on a group: into it, at the end. On another row: before it. */
  protected drop(event: DragEvent, row: BookmarkRow): void {
    event.preventDefault();
    event.stopPropagation();
    const from = this.dragging();
    this.dragging.set(null);
    if (!from) return;
    if (row.kind === "group") {
      const group = row.bookmark as { items: Bookmark[] };
      this.bookmarks.move(from, row.path, group.items.length);
    } else {
      this.bookmarks.move(from, row.path.slice(0, -1), row.path[row.path.length - 1]!);
    }
  }

  /** Dropped on the empty area: at the end of the root. */
  protected dropAtEnd(event: DragEvent): void {
    event.preventDefault();
    const from = this.dragging();
    this.dragging.set(null);
    if (from) this.bookmarks.move(from, [], this.bookmarks.items().length);
  }
}

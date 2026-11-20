import { Component, computed, inject, signal } from "@angular/core";

import { Bookmark, ItemPath, isFile, isGroup, isSearch, labelOf } from "../../core/bookmarks/bookmarks-core";
import { BookmarksService } from "../../core/bookmarks/bookmarks.service";
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

const ICONS: Record<BookmarkRow["kind"], string> = { note: "📄", heading: "#", search: "🔍", group: "📁", other: "•" };

/** Sidebar: the bookmarks of the vault; drag to reorder or to move into a group. */
@Component({
  selector: "app-bookmarks",
  template: `
    <header>
      <span>Bookmarks</span>
      <button type="button" class="add" (click)="bookmarks.addGroup()" title="New group" aria-label="New group">+</button>
    </header>
    @if (rows().length === 0) {
      <p class="status">No bookmarks yet. Bookmark a note, a heading or a search from the command palette.</p>
    }
    <ul role="tree" aria-label="Bookmarks" (dragover)="$event.preventDefault()" (drop)="dropAtEnd($event)">
      @for (row of rows(); track row.path.join(".")) {
        <li
          role="treeitem"
          draggable="true"
          [attr.data-kind]="row.kind"
          [style.padding-left.px]="8 + row.depth * 14"
          (dragstart)="dragging.set(row.path)"
          (dragend)="dragging.set(null)"
          (dragover)="$event.preventDefault(); $event.stopPropagation()"
          (drop)="drop($event, row)"
        >
          <span class="icon" aria-hidden="true">{{ icon(row) }}</span>
          @if (editing()?.join('.') === row.path.join('.')) {
            <input
              #name
              class="rename"
              type="text"
              aria-label="Group name"
              [value]="label(row)"
              (click)="$event.stopPropagation()"
              (keydown.enter)="commit(row, name.value)"
              (keydown.escape)="editing.set(null)"
              (blur)="commit(row, name.value)"
            />
          } @else {
            <button type="button" class="label" [title]="label(row)" (click)="open(row)" (dblclick)="rename(row)">{{ label(row) }}</button>
          }
          <button type="button" class="remove" (click)="bookmarks.remove(row.path)" title="Remove bookmark" aria-label="Remove bookmark">×</button>
        </li>
      }
    </ul>
  `,
  styles: `
    :host { display: flex; flex-direction: column; flex: 1; min-width: 0; overflow-y: auto; background: var(--h-surface-frame); color: var(--h-text-color); font-size: 13px; }
    header { display: flex; align-items: center; justify-content: space-between; height: 34px; padding: 0 12px; border-bottom: 1px solid var(--h-content-border-color); font-size: 11px; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; color: var(--h-text-muted-color); }
    ul { list-style: none; margin: 0; padding: 4px 0; flex: 1; }
    li { display: flex; align-items: center; gap: 6px; padding-right: 8px; min-height: 26px; }
    li:hover { background: var(--h-hover-bg, rgba(127, 127, 127, 0.12)); }
    .status { margin: 8px 12px; color: var(--h-text-muted-color); }
    button { border: 0; background: none; color: inherit; font: inherit; cursor: pointer; }
    .label { flex: 1; min-width: 0; text-align: left; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding: 2px 0; }
    .remove { visibility: hidden; color: var(--h-text-muted-color); }
    li:hover .remove { visibility: visible; }
    .rename { flex: 1; min-width: 0; font: inherit; }
    li[data-kind="group"] .label { font-weight: 600; }
  `,
})
export class BookmarksComponent {
  protected readonly bookmarks = inject(BookmarksService);
  private readonly search = inject(SearchService);
  private readonly shell = inject(ShellService);

  protected readonly rows = computed(() => bookmarkRows(this.bookmarks.items()));
  protected readonly dragging = signal<ItemPath | null>(null);
  protected readonly editing = signal<ItemPath | null>(null);

  protected icon(row: BookmarkRow): string {
    return ICONS[row.kind];
  }

  protected label(row: BookmarkRow): string {
    return labelOf(row.bookmark);
  }

  protected open(row: BookmarkRow): void {
    if (row.kind === "group") return;
    void this.bookmarks
      .open(row.bookmark, (query) => {
        this.shell.show("search");
        void this.search.setQuery(query);
      })
      .catch((err) => this.bookmarks.notice.set(String(err)));
  }

  protected rename(row: BookmarkRow): void {
    if (row.kind === "group") this.editing.set(row.path);
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

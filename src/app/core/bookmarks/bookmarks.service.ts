import { Injectable, computed, effect, inject, signal, untracked } from "@angular/core";
import { listen } from "@tauri-apps/api/event";

import type { VaultChange } from "../file/backend";
import { VAULT_CHANGED_EVENT, backend } from "../file/backend";
import { DocumentService } from "../file/document.service";
import { SearchService } from "../index/search.service";
import { outlineOf } from "../outline/outline-core";
import { OutlineService } from "../outline/outline.service";
import { SettingsService } from "../settings/settings.service";
import { WorkspaceService } from "../workspace/workspace.service";
import type {
  Bookmark,
  BookmarkFile,
  FileBookmark,
  ItemPath,
  SearchBookmark,
} from "./bookmarks-core";
import {
  addBookmark,
  addGroup,
  contains,
  headingLine,
  isDamaged,
  isFile,
  isSearch,
  moveItem,
  parseAppStore,
  parseBookmarks,
  removeAt,
  removeMatching,
  renameGroup,
  renamePath,
  serializeBookmarks,
} from "./bookmarks-core";

/** Where the bookmarks of the open vault are kept now. */
export type BookmarkStore = "vault" | "app";

/**
 * The bookmarks of the open vault: notes, headings and searches in groups. They are kept in
 * `.obsidian/bookmarks.json` when the setting allows it and the vault has an `.obsidian` folder, else in
 * the app data directory (one entry per vault). A vault file that exists is read either way, to start
 * the app data copy; a file that cannot be read is never overwritten.
 */
@Injectable({ providedIn: "root" })
export class BookmarksService {
  private readonly workspace = inject(WorkspaceService);
  private readonly settings = inject(SettingsService);
  private readonly doc = inject(DocumentService);
  private readonly outline = inject(OutlineService);
  private readonly search = inject(SearchService);

  private file: BookmarkFile = { items: [], extra: {} };
  readonly items = signal<Bookmark[]>([]);
  /** The store in use; null before the bookmarks are loaded. */
  readonly store = signal<BookmarkStore | null>(null);
  readonly notice = signal<string | null>(null);

  private loadedFor: string | null = null;
  private writable = false;
  private writing: Promise<void> = Promise.resolve();
  private generation = 0;

  /** True when the open note is bookmarked as a whole. */
  readonly noteBookmarked = computed(() => {
    const path = this.relative(this.doc.path());
    return path !== null && contains(this.items(), { type: "file", path });
  });

  constructor() {
    effect(() => {
      const root = this.workspace.vaultRoot();
      const inVault = this.settings.bookmarksInVault();
      untracked(() => void this.load(root, inVault));
    });
  }

  /** Listens for renames made outside the app (the file watcher). */
  async init(): Promise<void> {
    await listen<VaultChange[]>(VAULT_CHANGED_EVENT, (e) => {
      for (const c of e.payload ?? [])
        if (c.kind === "rename" && c.from) this.renamed(c.from, c.path);
    });
  }

  /** The vault-relative form of an absolute path inside the vault; null outside it. */
  relative(path: string | null): string | null {
    const root = this.workspace.vaultRoot();
    if (!path || !root || !path.startsWith(`${root}/`)) return null;
    return path.slice(root.length + 1);
  }

  private async load(root: string | null, inVault: boolean): Promise<void> {
    const generation = ++this.generation;
    this.writable = false;
    this.loadedFor = root;
    this.file = { items: [], extra: {} };
    this.items.set([]);
    this.store.set(null);
    if (!root) return;
    try {
      let vaultUnreadable = false;
      const fromVault = await backend.readVaultBookmarks().catch(() => {
        vaultUnreadable = true;
        return null;
      });
      const useVault = inVault && (fromVault !== null || (await this.vaultHasFolder()));
      const stored = parseAppStore(await backend.readAppBookmarks());
      const fromApp = root in stored ? parseBookmarks(JSON.stringify(stored[root])) : null;
      // The vault file wins when it is the store; else the app copy, started from the vault file.
      const file = useVault
        ? fromVault !== null
          ? parseBookmarks(fromVault)
          : (fromApp ?? parseBookmarks(null))
        : (fromApp ?? parseBookmarks(fromVault));
      if (generation !== this.generation) return;
      this.file = file;
      this.items.set(file.items);
      this.store.set(useVault ? "vault" : "app");
      // A vault file that exists but cannot be read or parsed is left alone.
      const keep = useVault && (vaultUnreadable || isDamaged(fromVault));
      this.writable = !keep;
      if (keep)
        this.notice.set(
          "Bookmarks of the vault are not readable; they are left as they are and not changed.",
        );
    } catch (err) {
      if (generation === this.generation) console.warn("bookmarks unavailable", err);
    }
  }

  /** Whether the vault has an `.obsidian` folder, so a file can be written into it. */
  private async vaultHasFolder(): Promise<boolean> {
    const root = this.workspace.vaultRoot();
    return root ? backend.isDir(`${root}/.obsidian`).catch(() => false) : false;
  }

  private commit(items: Bookmark[]): void {
    if (!this.writable || items === this.items()) return;
    this.file = { ...this.file, items };
    this.items.set(items);
    this.save();
  }

  private save(): void {
    const root = this.loadedFor;
    const store = this.store();
    if (!root || !store) return;
    const file = this.file;
    this.writing = this.writing
      .then(async () => {
        if (store === "vault") {
          await backend.writeVaultBookmarks(serializeBookmarks(file));
          return;
        }
        // The app data file holds every vault: read it again so another vault's entry stays.
        const all = parseAppStore(await backend.readAppBookmarks());
        all[root] = { ...file.extra, items: file.items };
        await backend.writeAppBookmarks(JSON.stringify(all, null, 2));
      })
      .catch((err) => {
        console.warn("bookmarks not saved", err);
        this.notice.set(`Bookmarks not saved: ${err}`);
      });
  }

  /** Resolves when the writes started so far are done. */
  flush(): Promise<void> {
    return this.writing;
  }

  private now(): number {
    return Date.now();
  }

  /** Bookmarks or un-bookmarks the open note. */
  toggleNote(path = this.doc.path()): void {
    const rel = this.relative(path);
    if (rel === null) return;
    this.toggle({ type: "file", path: rel });
  }

  /** Bookmarks a heading of a note (vault-relative path, heading text). */
  bookmarkHeading(path: string, heading: string): void {
    this.toggle({ type: "file", path, subpath: `#${heading}` });
  }

  /** Bookmarks the heading at the top of the open note; false when there is none. */
  bookmarkCurrentHeading(): boolean {
    const rel = this.relative(this.doc.path());
    const headings = this.outline.headings();
    const heading = headings[this.outline.current()];
    if (rel === null || !heading) return false;
    this.bookmarkHeading(rel, heading.text);
    return true;
  }

  /** Bookmarks the query of the search panel; false when it is empty. */
  bookmarkSearch(query = this.search.query()): boolean {
    const q = query.trim();
    if (!q) return false;
    this.toggle({ type: "search", query: q });
    return true;
  }

  private toggle(probe: FileBookmark | SearchBookmark): void {
    const items = this.items();
    this.commit(
      contains(items, probe) ? removeMatching(items, probe) : addBookmark(items, probe, this.now()),
    );
  }

  addGroup(title = "Group"): void {
    this.commit(addGroup(this.items(), title, this.now()));
  }

  renameGroup(path: ItemPath, title: string): void {
    this.commit(renameGroup(this.items(), path, title.trim()));
  }

  remove(path: ItemPath): void {
    this.commit(removeAt(this.items(), path));
  }

  move(from: ItemPath, parent: ItemPath, index: number): void {
    this.commit(moveItem(this.items(), from, parent, index));
  }

  /** A note or folder was renamed or moved (vault-relative paths): its bookmarks follow. */
  renamed(from: string, to: string): void {
    this.commit(renamePath(this.items(), from, to));
  }

  /** Opens a bookmark: a note (at its heading) or the search. */
  async open(bookmark: Bookmark, onSearch: (query: string) => void): Promise<void> {
    if (isSearch(bookmark)) {
      onSearch(bookmark.query);
      return;
    }
    const root = this.workspace.vaultRoot();
    if (!isFile(bookmark) || !root) return;
    await this.doc.open(`${root}/${bookmark.path}`);
    const line = headingLine(bookmark.subpath, outlineOf(this.doc.content()));
    if (line !== null) this.doc.pendingLine.set(line);
  }
}

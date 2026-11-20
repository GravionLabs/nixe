import { Component, ElementRef, computed, effect, inject, output, signal, viewChild } from "@angular/core";

import { DocumentService } from "../../core/file/document.service";
import { BookmarksService } from "../../core/bookmarks/bookmarks.service";
import { ChangesService } from "../../core/git/changes.service";
import { basename } from "../../core/markdown/paths";
import { TabsService } from "../../core/tabs/tabs.service";
import { FocusKey, focusTarget, parentIndex, rangeBetween, typeAheadMatch } from "../../core/workspace/tree-nav";
import { topLevelPaths } from "../../core/workspace/file-ops";
import { VaultOpsService } from "../../core/workspace/vault-ops.service";
import { TREE_SORTS, TREE_SORT_LABELS, TreeSort, conflictPaths } from "../../core/workspace/tree-model";
import { TreeNode, WorkspaceService } from "../../core/workspace/workspace.service";

/** The context menu: where it is shown and what it acts on (`null`: the empty area, i.e. the root). */
export interface MenuState {
  x: number;
  y: number;
  node: TreeNode | null;
}

@Component({
  selector: "app-sidebar",
  templateUrl: "./sidebar.component.html",
  styleUrl: "./sidebar.component.css",
})
export class SidebarComponent {
  protected readonly workspace = inject(WorkspaceService);
  protected readonly doc = inject(DocumentService);
  protected readonly changes = inject(ChangesService);
  private readonly ops = inject(VaultOpsService);
  private readonly tabs = inject(TabsService);
  private readonly bookmarks = inject(BookmarksService);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  readonly error = output<string>();

  /** Files of a sync conflict: the copies and the originals next to them. */
  protected readonly conflicted = computed(() =>
    conflictPaths(this.workspace.visible().flatMap((n) => (n.filePath ? [n.filePath] : []))),
  );
  protected readonly sortMenu = signal<{ x: number; y: number } | null>(null);
  protected readonly sortOptions = TREE_SORTS.map((value) => ({ value, label: TREE_SORT_LABELS[value] }));
  protected readonly menu = signal<MenuState | null>(null);
  /** Path of the entry whose name is being edited. */
  protected readonly renaming = signal<string | null>(null);
  private readonly renameInput = viewChild<ElementRef<HTMLInputElement>>("renameInput");
  private renameDone = false;
  /** Paths of the selected rows; the click, Ctrl/Cmd, Shift and Space keys change it. */
  protected readonly selection = signal<ReadonlySet<string>>(new Set());
  /** The row with the focus, the one tab stop of the tree (roving tabindex). */
  protected readonly focused = signal<string | null>(null);
  /** The folder under the pointer while dragging. */
  protected readonly dropTarget = signal<string | null>(null);
  private anchor: string | null = null;
  private dragPaths: string[] = [];
  private typed = "";
  private typedAt = 0;
  protected readonly tabStop = computed(() => {
    const rows = this.workspace.visible();
    const focused = this.focused();
    return rows.some((n) => this.path(n) === focused) ? focused : rows.length ? this.path(rows[0]) : null;
  });
  protected readonly basename = basename;
  protected readonly revealLabel = /Mac/u.test(navigator.userAgent)
    ? "Reveal in Finder"
    : /Win/u.test(navigator.userAgent)
      ? "Show in Explorer"
      : "Show in file manager";

  constructor() {
    // Reveal the active note: once the expanded folders are rendered, scroll its row into view.
    effect(() => {
      if (this.workspace.revealRequest() === 0) return;
      setTimeout(() => this.host.nativeElement.querySelector(".row.active")?.scrollIntoView?.({ block: "nearest" }));
    });
    effect(() => {
      const input = this.renameInput()?.nativeElement;
      if (!input) return;
      input.focus();
      const dot = input.value.lastIndexOf(".");
      input.setSelectionRange(0, dot > 0 ? dot : input.value.length);
    });
  }

  protected openSortMenu(event: MouseEvent): void {
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    this.sortMenu.set({ x: rect.left, y: rect.bottom });
  }

  protected chooseSort(sort: TreeSort): Promise<void> {
    this.sortMenu.set(null);
    return this.attempt(() => this.workspace.setSort(sort));
  }

  protected path(node: TreeNode): string {
    return (node.filePath ?? node.dirPath) as string;
  }

  protected rowTabindex(node: TreeNode): number {
    return this.path(node) === this.tabStop() ? 0 : -1;
  }

  protected async select(node: TreeNode, event?: MouseEvent): Promise<void> {
    const path = this.path(node);
    this.focused.set(path);
    if (event && (event.metaKey || event.ctrlKey)) {
      this.toggleSelected(path);
      return;
    }
    if (event?.shiftKey && this.anchor !== null) {
      this.selectRange(this.anchor, path);
      return;
    }
    this.selection.set(new Set([path]));
    this.anchor = path;
    try {
      if (node.filePath) {
        if (event?.altKey) await this.tabs.openInNewTab(node.filePath);
        else await this.doc.open(node.filePath);
        if (node.dirPath && !node.expanded()) await this.workspace.toggle(node, true);
      } else {
        await this.workspace.toggle(node);
      }
    } catch (err) {
      this.error.emit(String(err));
    }
  }

  private toggleSelected(path: string): void {
    const next = new Set(this.selection());
    if (!next.delete(path)) next.add(path);
    this.selection.set(next);
    this.anchor = path;
  }

  private selectRange(from: string, to: string): void {
    const paths = this.workspace.visible().map((n) => this.path(n));
    const [a, b] = [paths.indexOf(from), paths.indexOf(to)];
    if (a < 0 || b < 0) return;
    this.selection.set(new Set(rangeBetween(a, b).map((i) => paths[i])));
  }

  private focusRow(index: number): void {
    const node = this.workspace.visible()[index];
    if (!node) return;
    const path = this.path(node);
    this.focused.set(path);
    const row = [...this.host.nativeElement.querySelectorAll<HTMLElement>(".row")].find((r) => r.dataset["path"] === path);
    row?.focus();
    row?.scrollIntoView?.({ block: "nearest" });
  }

  /** Keyboard handling of one row, after the WAI-ARIA tree pattern. */
  protected onKeydown(node: TreeNode, event: KeyboardEvent): void {
    const path = this.path(node);
    if (this.renaming() === path) return;
    const rows = this.workspace.visible();
    const index = rows.indexOf(node);
    switch (event.key) {
      case "ArrowDown":
      case "ArrowUp":
      case "Home":
      case "End": {
        event.preventDefault();
        const target = focusTarget(rows.length, index, event.key as FocusKey);
        if (event.shiftKey && target >= 0) {
          this.anchor ??= path;
          this.selectRange(this.anchor, this.path(rows[target]));
        }
        this.focusRow(target);
        return;
      }
      case "ArrowRight":
        event.preventDefault();
        if (!node.dirPath) return;
        if (!node.expanded()) void this.attempt(() => this.workspace.toggle(node, true));
        else if (rows[index + 1]?.depth > node.depth) this.focusRow(index + 1);
        return;
      case "ArrowLeft": {
        event.preventDefault();
        if (node.dirPath && node.expanded()) void this.attempt(() => this.workspace.toggle(node, false));
        else this.focusRow(parentIndex(rows.map((n) => n.depth), index));
        return;
      }
      case "Enter":
        event.preventDefault();
        void this.select(node);
        return;
      case " ":
        event.preventDefault();
        this.toggleSelected(path);
        return;
      case "F2":
        this.beginRename(node);
        return;
      case "Delete":
        event.preventDefault();
        void this.trashSelection(node);
        return;
    }
    if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      const now = Date.now();
      this.typed = now - this.typedAt > 700 ? event.key : this.typed + event.key;
      this.typedAt = now;
      const hit = typeAheadMatch(rows.map((n) => n.name), index, this.typed);
      if (hit >= 0) this.focusRow(hit);
    }
  }

  /** The paths an action on `node` covers: the selection when `node` is part of it, else `node`. */
  private actionPaths(node: TreeNode): string[] {
    const path = this.path(node);
    const selected = this.selection();
    return selected.has(path) ? this.workspace.visible().map((n) => this.path(n)).filter((p) => selected.has(p)) : [path];
  }

  private trashSelection(node: TreeNode): Promise<void> {
    return this.attempt(async () => {
      for (const path of topLevelPaths(this.actionPaths(node))) await this.ops.trash(path);
      this.selection.set(new Set());
    });
  }

  protected dragStart(event: DragEvent, node: TreeNode): void {
    const path = this.path(node);
    if (!this.selection().has(path)) {
      this.selection.set(new Set([path]));
      this.anchor = path;
    }
    this.dragPaths = this.actionPaths(node);
    event.dataTransfer?.setData("text/plain", this.dragPaths.join("\n"));
    if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
  }

  protected dragEnd(): void {
    this.dragPaths = [];
    this.dropTarget.set(null);
  }

  /** Only a folder, or the empty area (the root), takes a drop. */
  protected dragOver(event: DragEvent, node: TreeNode | null): void {
    event.stopPropagation();
    if (this.dragPaths.length === 0 || (node && !node.dirPath)) {
      this.dropTarget.set(null);
      return;
    }
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
    this.dropTarget.set(node ? node.dirPath : this.workspace.root());
  }

  protected drop(event: DragEvent, node: TreeNode | null): Promise<void> {
    event.stopPropagation();
    const dir = node ? node.dirPath : this.workspace.root();
    const paths = this.dragPaths;
    this.dragPaths = [];
    this.dropTarget.set(null);
    if (!dir || paths.length === 0) return Promise.resolve();
    event.preventDefault();
    return this.attempt(async () => {
      const moved = await this.ops.move(paths, dir);
      if (moved.length > 0) this.selection.set(new Set(moved));
    });
  }

  protected async toggle(node: TreeNode, event: Event): Promise<void> {
    event.stopPropagation();
    await this.workspace.toggle(node);
  }

  protected openMenu(event: MouseEvent, node: TreeNode | null): void {
    event.preventDefault();
    event.stopPropagation();
    this.menu.set({ x: event.clientX, y: event.clientY, node });
  }

  protected closeMenu(): void {
    this.menu.set(null);
  }

  /** The folder a new entry goes to: the folder itself, the folder of a file, else the tree root. */
  private targetDir(node: TreeNode | null): string | null {
    if (!node) return this.workspace.root();
    if (node.dirPath) return node.dirPath;
    const file = node.filePath as string;
    return file.slice(0, file.lastIndexOf("/"));
  }

  private async attempt(action: () => Promise<unknown>): Promise<void> {
    try {
      await action();
    } catch (err) {
      this.error.emit(String(err));
    }
  }

  protected newNote(): Promise<void> {
    const node = this.menu()?.node ?? null;
    this.closeMenu();
    return this.attempt(async () => {
      const dir = this.targetDir(node);
      if (!dir) return;
      if (node?.dirPath) await this.workspace.toggle(node, true);
      const path = await this.ops.createNote(dir);
      this.startRenaming(path);
    });
  }

  protected newFolder(): Promise<void> {
    const node = this.menu()?.node ?? null;
    this.closeMenu();
    return this.attempt(async () => {
      const dir = this.targetDir(node);
      if (!dir) return;
      if (node?.dirPath) await this.workspace.toggle(node, true);
      this.startRenaming(await this.ops.createFolder(dir));
    });
  }

  protected startRename(): void {
    const node = this.menu()?.node;
    this.closeMenu();
    if (node) this.beginRename(node);
  }

  protected beginRename(node: TreeNode): void {
    this.startRenaming(this.path(node));
  }

  private startRenaming(path: string): void {
    this.renameDone = false;
    this.renaming.set(path);
  }

  protected async commitRename(node: TreeNode, input: HTMLInputElement): Promise<void> {
    if (this.renameDone) return;
    this.renameDone = true;
    const path = this.path(node);
    this.renaming.set(null);
    if (input.value.trim() === basename(path)) return;
    await this.attempt(() => this.ops.rename(path, input.value));
  }

  protected cancelRename(): void {
    this.renameDone = true;
    this.renaming.set(null);
  }

  protected trash(): Promise<void> {
    const node = this.menu()?.node;
    this.closeMenu();
    return node ? this.trashSelection(node) : Promise.resolve();
  }

  /** The label of the bookmark entry for the note of the menu. */
  protected bookmarkLabel(node: TreeNode): string {
    const rel = this.bookmarks.relative(node.filePath);
    return rel !== null && this.bookmarks.items().some((b) => b.type === "file" && (b as { path?: string }).path === rel && !(b as { subpath?: string }).subpath)
      ? "Remove bookmark"
      : "Bookmark";
  }

  protected bookmark(): void {
    const node = this.menu()?.node;
    this.closeMenu();
    if (node?.filePath) this.bookmarks.toggleNote(node.filePath);
  }

  protected reveal(): Promise<void> {
    const node = this.menu()?.node;
    this.closeMenu();
    const path = node ? this.path(node) : this.workspace.root();
    return path ? this.attempt(() => this.ops.reveal(path)) : Promise.resolve();
  }
}

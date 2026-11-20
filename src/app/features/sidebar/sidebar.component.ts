import { Component, ElementRef, computed, effect, inject, output, signal, viewChild } from "@angular/core";

import { DocumentService } from "../../core/file/document.service";
import { BookmarksService } from "../../core/bookmarks/bookmarks.service";
import { ChangesService } from "../../core/git/changes.service";
import { basename } from "../../core/markdown/paths";
import { TabsService } from "../../core/tabs/tabs.service";
import { VaultOpsService } from "../../core/workspace/vault-ops.service";
import { conflictPaths } from "../../core/workspace/tree-model";
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
  readonly error = output<string>();

  /** Files of a sync conflict: the copies and the originals next to them. */
  protected readonly conflicted = computed(() =>
    conflictPaths(this.workspace.visible().flatMap((n) => (n.filePath ? [n.filePath] : []))),
  );
  protected readonly menu = signal<MenuState | null>(null);
  /** Path of the entry whose name is being edited. */
  protected readonly renaming = signal<string | null>(null);
  private readonly renameInput = viewChild<ElementRef<HTMLInputElement>>("renameInput");
  private renameDone = false;
  protected readonly basename = basename;
  protected readonly revealLabel = /Mac/u.test(navigator.userAgent)
    ? "Reveal in Finder"
    : /Win/u.test(navigator.userAgent)
      ? "Show in Explorer"
      : "Show in file manager";

  constructor() {
    effect(() => {
      const input = this.renameInput()?.nativeElement;
      if (!input) return;
      input.focus();
      const dot = input.value.lastIndexOf(".");
      input.setSelectionRange(0, dot > 0 ? dot : input.value.length);
    });
  }

  protected path(node: TreeNode): string {
    return (node.filePath ?? node.dirPath) as string;
  }

  protected async select(node: TreeNode, event?: MouseEvent): Promise<void> {
    try {
      if (node.filePath) {
        if (event && (event.metaKey || event.ctrlKey)) await this.tabs.openInNewTab(node.filePath);
        else await this.doc.open(node.filePath);
        if (node.dirPath && !node.expanded()) await this.workspace.toggle(node, true);
      } else {
        await this.workspace.toggle(node);
      }
    } catch (err) {
      this.error.emit(String(err));
    }
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
    if (!node) return Promise.resolve();
    return this.attempt(() => this.ops.trash(this.path(node)));
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

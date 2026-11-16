import { Component, ElementRef, effect, inject, output, signal, viewChild } from "@angular/core";

import { DocumentService } from "../../core/file/document.service";
import { basename } from "../../core/markdown/paths";
import { SettingsService } from "../../core/settings/settings.service";
import { VaultOpsService } from "../../core/workspace/vault-ops.service";
import { TreeNode, WorkspaceService } from "../../core/workspace/workspace.service";

const MIN_WIDTH = 160;
const MAX_WIDTH = 600;

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
  host: { "[style.width.px]": "settings.sidebarWidth()" },
})
export class SidebarComponent {
  protected readonly workspace = inject(WorkspaceService);
  protected readonly doc = inject(DocumentService);
  protected readonly settings = inject(SettingsService);
  private readonly ops = inject(VaultOpsService);
  readonly error = output<string>();

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

  protected async select(node: TreeNode): Promise<void> {
    try {
      if (node.filePath) {
        await this.doc.open(node.filePath);
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

  protected reveal(): Promise<void> {
    const node = this.menu()?.node;
    this.closeMenu();
    const path = node ? this.path(node) : this.workspace.root();
    return path ? this.attempt(() => this.ops.reveal(path)) : Promise.resolve();
  }

  protected startResize(event: PointerEvent): void {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = this.settings.sidebarWidth();
    const handle = event.target as HTMLElement;
    handle.setPointerCapture(event.pointerId);

    const move = (e: PointerEvent) => {
      const width = startWidth + e.clientX - startX;
      this.settings.sidebarWidth.set(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, width)));
    };
    const stop = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", stop);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", stop);
  }
}

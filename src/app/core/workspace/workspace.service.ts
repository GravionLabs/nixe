import { DEFAULT_PANEL_WIDTH } from "../panel/panel-width";
import type { WritableSignal } from "@angular/core";
import { Injectable, computed, effect, inject, signal, untracked } from "@angular/core";
import { open } from "@tauri-apps/plugin-dialog";

import { backend } from "../file/backend";
import { DocumentService } from "../file/document.service";
import { basename, joinPath, toSlashes } from "../markdown/paths";
import { SettingsService } from "../settings/settings.service";
import { layoutHasNote } from "../tabs/layout";
import { TabsService } from "../tabs/tabs.service";
import { filterTree, matchesFilter } from "./tree-filter";
import type { TreeItem, TreeSort } from "./tree-model";
import { buildTreeItems, defaultPage, sortItems } from "./tree-model";

export interface TreeNode extends TreeItem {
  depth: number;
  expanded: WritableSignal<boolean>;
  /** null until the folder was listed. */
  children: WritableSignal<TreeNode[] | null>;
}

/** The opened folder and its (lazily loaded) file tree. */
@Injectable({ providedIn: "root" })
export class WorkspaceService {
  private readonly doc = inject(DocumentService);
  private readonly settings = inject(SettingsService);
  private readonly tabs = inject(TabsService);

  readonly root = signal<string | null>(null);
  /** Order of the tree. */
  readonly sort = computed(() => this.settings.treeSort());
  readonly rootName = computed(() => {
    const r = this.root();
    return r ? basename(r) : null;
  });
  /** Vault root of the opened folder (topmost ancestor with `.obsidian/`, else the folder itself). */
  readonly vaultRoot = signal<string | null>(null);
  /** Vault-relative files, held in memory for wikilink resolution. */
  readonly vaultFiles = signal<readonly string[] | null>(null);
  private readonly rootNodes = signal<TreeNode[]>([]);
  /** The further roots of a workspace (#116), each as a folder row below the tree of the first. */
  readonly extraRoots = signal<TreeNode[]>([]);
  private rootHasOrder = false;

  constructor() {
    // The open note is remembered per vault; a note outside the opened folder (or one that is still
    // the previous vault's while the switch runs) is not.
    effect(() => {
      const note = this.doc.path();
      const root = this.root();
      // The tabs and the split are part of the state: changing them stores it again.
      this.tabs.panes();
      this.tabs.focusedId();
      // Closing every note stores the empty layout too, so the old tabs do not come back.
      if (root && !this.opening && (note === null || note.startsWith(`${root}/`))) {
        untracked(() => this.rememberState(root, note));
      }
    });
    window.addEventListener("pagehide", () => {
      const root = this.root();
      if (root) this.rememberState(root, this.noteIn(root));
    });
  }

  /** Flattened list of visible rows (expanded folders only). */
  readonly visible = computed(() => {
    const rows: TreeNode[] = [];
    const walk = (nodes: TreeNode[]) => {
      for (const node of nodes) {
        rows.push(node);
        if (node.expanded()) walk(node.children() ?? []);
      }
    };
    walk(this.rootNodes());
    walk(this.extraRoots());
    return rows;
  });

  /** The text the file tree is narrowed to by name (#248); empty shows the whole tree. */
  readonly treeFilter = signal("");

  /** With a filter: the loaded notes and folders that match, with the folders leading to them. */
  readonly filteredRows = computed(() => filterTree(this.rootNodes(), this.treeFilter()));

  /** Sets the filter and expands the folders of the matches that are not loaded yet. */
  async setTreeFilter(text: string): Promise<void> {
    this.treeFilter.set(text);
    const vaultRoot = this.vaultRoot();
    if (text.trim() === "" || !vaultRoot) return;
    const targets = new Set<string>();
    for (const rel of this.vaultFiles() ?? []) {
      const parts = rel.split("/");
      parts.forEach((part, i) => {
        if (!matchesFilter(part, text)) return;
        const last = i === parts.length - 1;
        targets.add(joinPath(vaultRoot, last ? rel : `${parts.slice(0, i + 1).join("/")}/.`));
      });
      if (targets.size > 500) break;
    }
    for (const target of targets) {
      if (this.treeFilter() !== text) return;
      await this.reveal(target);
    }
  }

  /** True while a folder is being opened: the state stored for it must not be overwritten yet. */
  private opening = false;

  async openFolder(path: string, options: { openDefaultPage?: boolean } = {}): Promise<void> {
    this.opening = true;
    try {
      await this.openFolderNow(path, options);
    } finally {
      this.opening = false;
    }
  }

  private async openFolderNow(path: string, options: { openDefaultPage?: boolean }): Promise<void> {
    const { openDefaultPage = true } = options;
    path = toSlashes(path);
    const previous = this.root();
    if (previous && previous !== path) this.rememberState(previous, this.noteIn(previous));
    const switching = previous !== path;
    const hasOrder = await backend.isFile(joinPath(path, ".order"));
    const nodes = await this.load(path, hasOrder, 0);
    const vaultRoot = toSlashes(await backend.findVaultRoot(path));
    const vaultFiles = await backend.listVaultFiles(vaultRoot);
    this.rootHasOrder = hasOrder;
    this.vaultRoot.set(vaultRoot);
    this.vaultFiles.set(vaultFiles);
    this.root.set(path);
    this.rootNodes.set(nodes);
    this.settings.lastFolder.set(path);
    const state = switching ? this.settings.vaultStates()[path] : undefined;
    this.settings.noteVaultOpened(path);
    this.settings.sidebarVisible.set(state?.sidebar ?? true);
    if (state) {
      this.settings.backlinksVisible.set(state.backlinks);
      this.settings.outlineVisible.set(state.outline);
      this.settings.panelWidth.set(state.panelWidth ?? DEFAULT_PANEL_WIDTH);
    }

    if (switching) {
      this.tabs.reset();
      this.extraRoots.set([]);
    }
    if (openDefaultPage) {
      const layout = state?.layout;
      const restored = layout && layoutHasNote(layout) ? await this.tabs.restore(layout) : false;
      if (!restored) {
        const remembered = state?.note && (await backend.isFile(state.note)) ? state.note : null;
        const page = remembered ?? defaultPage(nodes);
        if (page) await this.doc.open(page);
      }
    }
    // After the first note is shown, so the scan never delays rendering. A failed index is not
    // fatal: the viewer works without it.
    backend.indexStart(vaultRoot).catch(() => undefined);
  }

  /**
   * Opens a vault of the recent list. A folder that no longer exists is removed from the list and
   * false is returned.
   */
  async openRecent(path: string): Promise<boolean> {
    if (!(await backend.isDir(path))) {
      this.settings.forgetVault(path);
      return false;
    }
    await this.openFolder(path);
    return true;
  }

  /** Removes the recent vaults whose folder is gone; returns them. */
  async pruneMissingRecent(): Promise<string[]> {
    const list = this.settings.recentVaults();
    const present = await Promise.all(list.map((p) => backend.isDir(p).catch(() => true)));
    const missing = list.filter((_, i) => !present[i]);
    for (const path of missing) this.settings.forgetVault(path);
    return missing;
  }

  private noteIn(root: string): string | null {
    const note = this.doc.path();
    return note && note.startsWith(`${root}/`) ? note : null;
  }

  private rememberState(root: string, note: string | null): void {
    const layout = this.tabs.snapshot();
    this.settings.rememberVaultState(root, {
      note,
      sidebar: this.settings.sidebarVisible(),
      backlinks: this.settings.backlinksVisible(),
      outline: this.settings.outlineVisible(),
      panelWidth: this.settings.panelWidth(),
      layout,
    });
  }

  async openFolderWithDialog(): Promise<void> {
    const selected = await open({ directory: true, multiple: false });
    if (typeof selected === "string") await this.openFolder(selected);
  }

  async refresh(): Promise<void> {
    const root = this.root();
    if (!root) return;
    await this.openFolder(root, { openDefaultPage: false });
    const current = this.doc.path();
    if (current) await this.reveal(current);
  }

  /** Re-reads the tree and the file list after a file operation; expanded folders stay open. */
  async reloadTree(): Promise<void> {
    const root = this.root();
    const vaultRoot = this.vaultRoot();
    if (!root || !vaultRoot) return;
    const open = new Set<string>();
    const collect = (nodes: TreeNode[]) => {
      for (const n of nodes) {
        if (n.dirPath && n.expanded()) open.add(n.dirPath);
        collect(n.children() ?? []);
      }
    };
    collect(this.rootNodes());
    const [nodes, files] = await Promise.all([
      this.loadOpen(root, this.rootHasOrder, 0, open),
      backend.listVaultFiles(vaultRoot),
    ]);
    this.rootNodes.set(nodes);
    this.vaultFiles.set(files);
  }

  private async loadOpen(
    dir: string,
    hasOrder: boolean,
    depth: number,
    open: Set<string>,
  ): Promise<TreeNode[]> {
    const nodes = await this.load(dir, hasOrder, depth);
    await Promise.all(
      nodes.map(async (node) => {
        if (!node.dirPath || !open.has(node.dirPath)) return;
        node.children.set(
          await this.loadOpen(node.dirPath, node.hasOrder, depth + 1, open).catch(() => []),
        );
        node.expanded.set(true);
      }),
    );
    return nodes;
  }

  /** Shows the folder `path` as a further root below the tree; one that is shown already stays. */
  addExtraRoot(path: string, name: string): void {
    path = toSlashes(path);
    if (path === this.root() || this.extraRoots().some((n) => n.dirPath === path)) return;
    const node: TreeNode = {
      name,
      dirPath: path,
      filePath: null,
      hasOrder: false,
      modified: 0,
      depth: 0,
      expanded: signal(false),
      children: signal<TreeNode[] | null>(null),
    };
    this.extraRoots.update((nodes) => [...nodes, node]);
  }

  /** Drops the further roots, keeping the first. */
  clearExtraRoots(): void {
    this.extraRoots.set([]);
  }

  /** Counts the requests to scroll the open note into view; the sidebar acts on it. */
  readonly revealRequest = signal(0);

  /** Changes the order of the tree; it is kept across restarts. */
  async setSort(sort: TreeSort): Promise<void> {
    if (this.settings.treeSort() === sort) return;
    this.settings.treeSort.set(sort);
    await this.reloadTree();
  }

  /** Folds every folder of the tree. */
  collapseAll(): void {
    const fold = (nodes: TreeNode[]) => {
      for (const n of nodes) {
        n.expanded.set(false);
        fold(n.children() ?? []);
      }
    };
    fold(this.rootNodes());
  }

  /** Expands the folders of the open note and asks the sidebar to scroll it into view. */
  async revealActive(): Promise<void> {
    const current = this.doc.path();
    if (!current) return;
    // A filter that hides the note would hide the reveal too.
    if (this.treeFilter() !== "") await this.setTreeFilter("");
    await this.reveal(current);
    this.revealRequest.update((n) => n + 1);
  }

  async toggle(node: TreeNode, expand = !node.expanded()): Promise<void> {
    if (!node.dirPath) return;
    if (expand && node.children() === null) {
      node.children.set(await this.load(node.dirPath, node.hasOrder, node.depth + 1));
    }
    node.expanded.set(expand);
  }

  /** Expands the folders leading to `filePath` so it is visible in the tree. */
  async reveal(filePath: string): Promise<void> {
    const root = this.root();
    if (!root || !filePath.startsWith(`${root}/`)) return;

    let nodes = this.rootNodes();
    for (;;) {
      if (nodes.some((n) => n.filePath === filePath)) return;
      const parent = nodes.find((n) => n.dirPath && filePath.startsWith(`${n.dirPath}/`));
      if (!parent) return;
      await this.toggle(parent, true);
      nodes = parent.children() ?? [];
    }
  }

  private async load(dir: string, hasOrder: boolean, depth: number): Promise<TreeNode[]> {
    const entries = await backend.listDir(dir);
    return sortItems(buildTreeItems(entries, hasOrder), this.settings.treeSort()).map((item) => ({
      ...item,
      depth,
      expanded: signal(false),
      children: signal<TreeNode[] | null>(null),
    }));
  }
}

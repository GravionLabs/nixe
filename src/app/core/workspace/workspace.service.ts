import { Injectable, WritableSignal, computed, effect, inject, signal, untracked } from "@angular/core";
import { open } from "@tauri-apps/plugin-dialog";

import { backend } from "../file/backend";
import { DocumentService } from "../file/document.service";
import { basename, joinPath, toSlashes } from "../markdown/paths";
import { SettingsService } from "../settings/settings.service";
import { layoutHasNote } from "../tabs/layout";
import { TabsService } from "../tabs/tabs.service";
import { TreeItem, buildTreeItems, defaultPage } from "./tree-model";

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
  readonly rootName = computed(() => {
    const r = this.root();
    return r ? basename(r) : null;
  });
  /** Vault root of the opened folder (topmost ancestor with `.obsidian/`, else the folder itself). */
  readonly vaultRoot = signal<string | null>(null);
  /** Vault-relative files, held in memory for wikilink resolution. */
  readonly vaultFiles = signal<readonly string[] | null>(null);
  private readonly rootNodes = signal<TreeNode[]>([]);
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
      if (root && note && note.startsWith(root + "/")) untracked(() => this.rememberState(root, note));
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
    return rows;
  });

  async openFolder(path: string, options: { openDefaultPage?: boolean } = {}): Promise<void> {
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
    }

    if (switching) this.tabs.reset();
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
    return note && note.startsWith(root + "/") ? note : null;
  }

  private rememberState(root: string, note: string | null): void {
    const layout = this.tabs.snapshot();
    this.settings.rememberVaultState(root, {
      note,
      sidebar: this.settings.sidebarVisible(),
      backlinks: this.settings.backlinksVisible(),
      outline: this.settings.outlineVisible(),
      ...(layoutHasNote(layout) ? { layout } : {}),
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

  private async loadOpen(dir: string, hasOrder: boolean, depth: number, open: Set<string>): Promise<TreeNode[]> {
    const nodes = await this.load(dir, hasOrder, depth);
    await Promise.all(
      nodes.map(async (node) => {
        if (!node.dirPath || !open.has(node.dirPath)) return;
        node.children.set(await this.loadOpen(node.dirPath, node.hasOrder, depth + 1, open).catch(() => []));
        node.expanded.set(true);
      }),
    );
    return nodes;
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
    if (!root || !filePath.startsWith(root + "/")) return;

    let nodes = this.rootNodes();
    for (;;) {
      if (nodes.some((n) => n.filePath === filePath)) return;
      const parent = nodes.find((n) => n.dirPath && filePath.startsWith(n.dirPath + "/"));
      if (!parent) return;
      await this.toggle(parent, true);
      nodes = parent.children() ?? [];
    }
  }

  private async load(dir: string, hasOrder: boolean, depth: number): Promise<TreeNode[]> {
    const entries = await backend.listDir(dir);
    return buildTreeItems(entries, hasOrder).map((item) => ({
      ...item,
      depth,
      expanded: signal(false),
      children: signal<TreeNode[] | null>(null),
    }));
  }
}

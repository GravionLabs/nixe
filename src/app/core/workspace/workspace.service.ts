import { Injectable, WritableSignal, computed, inject, signal } from "@angular/core";
import { open } from "@tauri-apps/plugin-dialog";

import { backend } from "../file/backend";
import { DocumentService } from "../file/document.service";
import { basename, joinPath, toSlashes } from "../markdown/paths";
import { SettingsService } from "../settings/settings.service";
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

  readonly root = signal<string | null>(null);
  readonly rootName = computed(() => {
    const r = this.root();
    return r ? basename(r) : null;
  });
  private readonly rootNodes = signal<TreeNode[]>([]);

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
    const hasOrder = await backend.isFile(joinPath(path, ".order"));
    const nodes = await this.load(path, hasOrder, 0);
    this.root.set(path);
    this.rootNodes.set(nodes);
    this.settings.lastFolder.set(path);
    this.settings.sidebarVisible.set(true);

    if (openDefaultPage) {
      const page = defaultPage(nodes);
      if (page) await this.doc.open(page);
    }
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

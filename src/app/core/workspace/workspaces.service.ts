import { Injectable, inject, signal } from "@angular/core";
import { open } from "@tauri-apps/plugin-dialog";

import type { Workspace } from "../file/backend";
import { backend } from "../file/backend";
import { CommandRegistry } from "../commands/command-registry";
import { basename } from "../markdown/paths";
import { WorkspaceService } from "./workspace.service";

/** Command id of "open the saved workspace `name`". */
export const OPEN_WORKSPACE_PREFIX = "open-workspace:";

/** A name for a workspace that was not named: the names of its roots. */
export function defaultWorkspaceName(workspace: Workspace): string {
  const names = workspace.roots.map((r) => r.name).join(" + ");
  return (
    names
      .replace(/[/\\:*?"<>|]/g, "-")
      .replace(/^\.+/, "")
      .slice(0, 100) || "Workspace"
  );
}

/**
 * Several folders in one window (#116). The workspace is saved by name in the app data directory,
 * never in the folders. Each root keeps its kind; links resolve inside the root, and
 * `[[Root name:Note]]` reaches a note of another root.
 */
@Injectable({ providedIn: "root" })
export class WorkspacesService {
  private readonly workspace = inject(WorkspaceService);
  private readonly commands = inject(CommandRegistry);

  /** The workspace of the window; null while only one folder is open. */
  readonly current = signal<Workspace | null>(null);
  readonly saved = signal<string[]>([]);
  private unregister: (() => void)[] = [];

  /** Asks for a folder and adds it as a root. */
  async addFolderWithDialog(): Promise<void> {
    const selected = await open({ directory: true, multiple: false });
    if (typeof selected === "string") await this.addFolder(selected);
  }

  /** Adds `path` as a root; the open folder becomes the first root when there is no workspace yet. */
  async addFolder(path: string): Promise<void> {
    let ws = this.current();
    const first = this.workspace.vaultRoot();
    if (!ws) {
      if (!first) throw new Error("Open a folder first.");
      ws = await backend.workspaceAddRoot({ name: "", roots: [] }, first);
    }
    ws = await backend.workspaceAddRoot(ws, path);
    this.current.set(ws);
    this.show(ws);
  }

  /** Saves the workspace under `name` (default: the root names) and lists it as a command. */
  async save(name?: string): Promise<string> {
    const ws = this.current();
    if (!ws) throw new Error("Add a folder to the workspace first.");
    const saved = { ...ws, name: name?.trim() || ws.name || defaultWorkspaceName(ws) };
    await backend.workspaceSave(saved);
    this.current.set(saved);
    await this.refreshSaved();
    return saved.name;
  }

  /** Reopens a saved workspace: its first root as the folder, the others below it. */
  async openSaved(name: string): Promise<void> {
    const ws = await backend.workspaceLoad(name);
    const present = (
      await Promise.all(ws.roots.map(async (r) => ((await backend.isDir(r.path)) ? r : null)))
    ).filter((r) => r !== null);
    if (present.length === 0) throw new Error(`No folder of the workspace "${name}" exists.`);
    await this.workspace.openFolder(present[0].path);
    this.current.set(ws);
    this.show({ ...ws, roots: present });
  }

  async forget(name: string): Promise<void> {
    await backend.workspaceDelete(name);
    if (this.current()?.name === name) this.current.update((w) => (w ? { ...w, name: "" } : w));
    await this.refreshSaved();
  }

  /** Reads the saved workspaces and registers one palette command per workspace. */
  async refreshSaved(): Promise<void> {
    const names = await backend.workspaceList().catch(() => [] as string[]);
    this.saved.set(names);
    for (const off of this.unregister) off();
    this.unregister = names.map((name) =>
      this.commands.register({
        id: `${OPEN_WORKSPACE_PREFIX}${name}`,
        title: `Open workspace: ${name}`,
        run: () => this.openSaved(name),
      }),
    );
  }

  private show(ws: Workspace): void {
    this.workspace.clearExtraRoots();
    const first = this.workspace.vaultRoot();
    for (const root of ws.roots) {
      if (root.path !== first)
        this.workspace.addExtraRoot(root.path, root.name || basename(root.path));
    }
  }
}

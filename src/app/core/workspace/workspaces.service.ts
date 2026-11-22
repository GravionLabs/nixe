import { Injectable, computed, effect, inject, signal, untracked } from "@angular/core";
import { open } from "@tauri-apps/plugin-dialog";

import type { RootArg, Workspace } from "../file/backend";
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
  /** The folders search and quick switcher cover; null while the window has one folder. */
  readonly searchRoots = computed<RootArg[] | null>(() => {
    const roots = this.current()?.roots ?? [];
    return roots.length > 1 ? roots.map((r) => ({ path: r.path, name: r.name })) : null;
  });
  /** Counts the finished index passes over the further roots, so searches run again. */
  readonly indexRevision = signal(0);
  private unregister: (() => void)[] = [];

  constructor() {
    // Another folder in the window ends the workspace: its extra roots are dropped with it.
    effect(() => {
      const first = this.workspace.root();
      untracked(() => {
        const ws = this.current();
        if (ws && !ws.roots.some((r) => r.path === first)) this.current.set(null);
      });
    });
  }

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

  /**
   * The note a `[[Root name:Note]]` link or a link inside a further root points to, as an absolute
   * path; `undefined` when the workspace does not decide (no workspace, or an ordinary link of the
   * first root), `null` when it finds no note.
   */
  async resolveLink(target: string, notePath: string | null): Promise<string | null | undefined> {
    const ws = this.current();
    if (!ws) return undefined;
    const prefix = target.includes(":") ? target.slice(0, target.indexOf(":")).trim() : null;
    const named = prefix
      ? ws.roots.some((r) => r.name.toLowerCase() === prefix.toLowerCase())
      : false;
    const from = notePath ? ws.roots.find((r) => notePath.startsWith(`${r.path}/`)) : undefined;
    if (!named && (!from || from.path === this.workspace.vaultRoot())) return undefined;
    const [hit] = await backend.workspaceResolveLinks(ws, from?.path ?? ws.roots[0].path, [target]);
    return hit ? `${hit.root}/${hit.path}` : null;
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
        group: "File",
        title: `Open workspace: ${name}`,
        run: () => this.openSaved(name),
      }),
    );
  }

  private show(ws: Workspace): void {
    void this.indexRoots(ws);
    this.workspace.clearExtraRoots();
    const first = this.workspace.vaultRoot();
    for (const root of ws.roots) {
      if (root.path !== first)
        this.workspace.addExtraRoot(root.path, root.name || basename(root.path));
    }
  }

  /** Scans the folders of the workspace so that search finds their notes (#117). */
  private async indexRoots(ws: Workspace): Promise<void> {
    if (ws.roots.length < 2) return;
    try {
      await backend.workspaceIndex(ws.roots.map((r) => ({ path: r.path, name: r.name })));
    } catch (err) {
      console.warn("workspace index failed", err);
    }
    this.indexRevision.update((n) => n + 1);
  }
}

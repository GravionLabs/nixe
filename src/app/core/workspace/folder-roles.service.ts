import { Injectable, computed, effect, inject, signal, untracked } from "@angular/core";

import type { LayoutEntry, VaultLayout } from "../file/backend";
import { backend } from "../file/backend";
import { toSlashes } from "../markdown/paths";
import { WorkspaceService } from "./workspace.service";

/** The standard folder roles of `.nixe/config.json` (ADR 0007). */
export const STANDARD_FOLDER_ROLES = [
  "inbox",
  "journal",
  "templates",
  "attachments",
  "projects",
  "areas",
  "resources",
  "archive",
  "clippings",
  "subjects",
  "sources",
  "exams",
] as const;

/** A folder role with its name. */
export interface FolderRole extends LayoutEntry {
  role: string;
}

/** The dialog "Set folder role…": the folder it is for and the role it starts with. */
export interface RoleDialog {
  /** Absolute path of the folder. */
  path: string;
  /** Vault-relative path. */
  rel: string;
  current: FolderRole | null;
}

/** The folder roles of the open vault: read, set and remove, and what the tree and the settings show. */
@Injectable({ providedIn: "root" })
export class FolderRolesService {
  private readonly workspace = inject(WorkspaceService);

  private readonly layout = signal<VaultLayout | null>(null);
  /** The roles of the vault, in the order of the file. */
  readonly roles = computed<FolderRole[]>(() =>
    Object.entries(this.layout()?.folders ?? {}).map(([role, entry]) => ({ role, ...entry })),
  );
  /** The dialog, or null while it is closed. */
  readonly dialog = signal<RoleDialog | null>(null);

  constructor() {
    effect(() => {
      this.workspace.vaultRoot();
      untracked(() => void this.reload());
    });
  }

  /** Reads `.nixe/config.json` again; without a vault there are no roles. */
  async reload(): Promise<void> {
    if (this.workspace.vaultRoot() === null) {
      this.layout.set(null);
      return;
    }
    try {
      const layout = await backend.vaultLayout();
      this.layout.set(layout?.folders ? layout : null);
    } catch {
      this.layout.set(null);
    }
  }

  /** The vault-relative path of an absolute one; null outside the vault or for the vault itself. */
  relative(path: string): string | null {
    const root = this.workspace.vaultRoot();
    const abs = toSlashes(path);
    return root && abs.startsWith(`${root}/`) ? abs.slice(root.length + 1) : null;
  }

  /** The role of the folder at the absolute `path`. */
  roleOf(path: string): FolderRole | null {
    const rel = this.relative(path);
    return rel === null ? null : (this.roles().find((r) => r.path === rel) ?? null);
  }

  /** The roles of the folder at the absolute `path` and of the folders below it. */
  rolesIn(path: string): FolderRole[] {
    const rel = this.relative(path);
    if (rel === null) return [];
    return this.roles().filter((r) => r.path === rel || r.path.startsWith(`${rel}/`));
  }

  /** The text for the tooltip of a folder with a role. */
  tooltip(role: FolderRole): string {
    return role.description
      ? `Folder role: ${role.role}: ${role.description}`
      : `Folder role: ${role.role}`;
  }

  /** Opens the dialog for the folder at `path`. */
  openDialog(path: string): void {
    const rel = this.relative(path);
    if (rel === null) return;
    this.dialog.set({ path, rel, current: this.roleOf(path) });
  }

  closeDialog(): void {
    this.dialog.set(null);
  }

  /**
   * Sets the role of the folder; a folder that has another role gets it replaced (removed first).
   * Rejects with the message of the backend (a name taken, an own role without a description).
   */
  async set(rel: string, role: string, description: string): Promise<void> {
    const name = role.trim();
    const text = description.trim();
    const current = this.roles().find((r) => r.path === rel);
    if (!name) throw new Error("A role needs a name.");
    if (!STANDARD_FOLDER_ROLES.includes(name as never) && !text) {
      throw new Error("An own role needs a description.");
    }
    if (current && current.role !== name) {
      const taken = this.roles().find((r) => r.role === name);
      if (taken) throw new Error(`The role ${name} is already set on ${taken.path}.`);
      await backend.removeFolderRole(rel);
    }
    this.layout.set(await backend.setFolderRole(rel, name, text || null));
  }

  async remove(rel: string): Promise<void> {
    this.layout.set(await backend.removeFolderRole(rel));
  }

  /** The warning for a deletion of `path` that holds roles; null when it holds none. */
  deleteWarning(path: string): string | null {
    const held = this.rolesIn(path);
    if (held.length === 0) return null;
    const names = held.map((r) => `${r.role} (${r.path})`).join(", ");
    return `Deleted a folder with a role. The role stays in .nixe/config.json and its folder is missing: ${names}.`;
  }
}

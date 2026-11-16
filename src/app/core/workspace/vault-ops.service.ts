import { Injectable, inject } from "@angular/core";
import { ask } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";

import { NewNoteLocation, RelinkChange, backend } from "../file/backend";
import { EditorService } from "../editor/editor.service";
import { DocumentService } from "../file/document.service";
import { basename, dirname, joinPath } from "../markdown/paths";
import { noteFromLinkTarget, remapPath, renamedName, uniqueName } from "./file-ops";
import { WorkspaceService } from "./workspace.service";

/** Creating, renaming and deleting notes and folders of the vault, and keeping the UI in step. */
@Injectable({ providedIn: "root" })
export class VaultOpsService {
  private readonly workspace = inject(WorkspaceService);
  private readonly doc = inject(DocumentService);
  private readonly editor = inject(EditorService);

  /** The folder a new note goes to: `.obsidian/app.json`, else the vault root. */
  async newNoteFolder(): Promise<string> {
    const vault = this.workspace.vaultRoot();
    if (!vault) throw new Error("No vault is open.");
    const setting: NewNoteLocation = await backend
      .newNoteLocation()
      .catch(() => ({ location: "root", folder: "" }) as NewNoteLocation);
    if (setting.location === "folder" && setting.folder) return joinPath(vault, setting.folder);
    const current = this.doc.path();
    if (setting.location === "current" && current?.startsWith(vault + "/")) return dirname(current);
    return vault;
  }

  /** `Untitled.md` (numbered if taken) in `dir`; opens it when `open` is set. Returns its path. */
  async createNote(dir?: string, options: { open?: boolean } = {}): Promise<string> {
    const folder = dir ?? (await this.newNoteFolder());
    await backend.createDir(folder);
    const name = uniqueName(await this.names(folder), "Untitled", ".md");
    const path = joinPath(folder, name);
    await backend.createFile(path);
    await this.changed();
    if (options.open ?? true) await this.openNote(path);
    return path;
  }

  /** The note a wikilink points to, created by the same rule as a new note; null for an empty target. */
  async createNoteForLink(target: string): Promise<string | null> {
    const vault = this.workspace.vaultRoot();
    const note = noteFromLinkTarget(target);
    if (!vault || !note) return null;
    const folder = note.folder ? joinPath(vault, note.folder) : await this.newNoteFolder();
    await backend.createDir(folder);
    const path = joinPath(folder, note.name);
    await backend.createFile(path);
    await this.changed();
    await this.openNote(path);
    return path;
  }

  async createFolder(dir: string): Promise<string> {
    const path = joinPath(dir, uniqueName(await this.names(dir), "Untitled", ""));
    await backend.createDir(path);
    await this.changed();
    return path;
  }

  /**
   * Renames or moves a note or folder; links to it are rewritten by the backend. A folder rename
   * lists the notes that change first. Returns the new path, or `path` when the user declines.
   */
  async rename(path: string, typed: string): Promise<string> {
    const name = renamedName(basename(path), typed);
    if (!name) throw new Error("That is not a valid name.");
    const to = joinPath(dirname(path), name);
    if (to === path) return path;
    await this.editor.handle?.flush();
    if (await backend.isDir(path)) {
      const changes = await backend.relinkPreview(path, to).catch(() => [] as RelinkChange[]);
      if (changes.length > 0 && !(await this.confirmRelink(changes))) return path;
    }
    await backend.renamePath(path, to);
    const open = this.doc.path();
    const moved = open ? remapPath(open, path, to) : null;
    if (open && moved && moved !== open) await this.doc.open(moved, { addToHistory: false });
    await this.changed();
    return to;
  }

  async trash(path: string): Promise<void> {
    const open = this.doc.path();
    const affected = open !== null && remapPath(open, path, "") !== open;
    // Pending text is written first, so closing the editor cannot recreate the note afterwards.
    if (affected) await this.editor.handle?.flush();
    await backend.trashPath(path);
    if (affected) {
      this.editor.editing.set(false);
      this.doc.close();
    }
    await this.changed();
  }

  private confirmRelink(changes: RelinkChange[]): Promise<boolean> {
    const shown = changes.slice(0, 10).map((c) => `• ${c.path} (${c.links})`);
    if (changes.length > shown.length) shown.push(`… and ${changes.length - shown.length} more`);
    return ask(`Links in ${changes.length} note(s) will be updated:\n\n${shown.join("\n")}`, {
      title: "Rename folder",
      okLabel: "Rename",
    });
  }

  reveal(path: string): Promise<void> {
    return revealItemInDir(path);
  }

  private async openNote(path: string): Promise<void> {
    await this.editor.handle?.flush();
    await this.doc.open(path);
  }

  private async names(dir: string): Promise<string[]> {
    const entries = await backend.listDir(dir).catch(() => []);
    return entries.map((e) => e.name);
  }

  private changed(): Promise<void> {
    return this.workspace.reloadTree();
  }
}

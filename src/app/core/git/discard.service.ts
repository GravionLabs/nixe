import { Injectable, inject } from "@angular/core";
import { ask } from "@tauri-apps/plugin-dialog";

import type { GitChange } from "../file/backend";
import { backend } from "../file/backend";
import { EditorService } from "../editor/editor.service";
import { basename, joinPath } from "../markdown/paths";
import { TabsService } from "../tabs/tabs.service";
import { VaultUndoService } from "../workspace/vault-undo.service";
import { WorkspaceService } from "../workspace/workspace.service";
import { GitService } from "./git.service";

/** What the user is asked before a note's changes are discarded, in plain words. */
export function discardQuestion(change: GitChange): string {
  const name = basename(change.path).replace(/\.(md|markdown|mdown|mkd)$/i, "");
  switch (change.kind) {
    case "added":
      return `Discard "${name}"? The note is deleted.`;
    case "deleted":
      return `Discard the deletion of "${name}"? The note is restored.`;
    default:
      return `Discard the changes of "${name}"? The note goes back to the last saved version.`;
  }
}

/** Takes the changes of one note back (#319); the undo of vault operations undoes it. */
@Injectable({ providedIn: "root" })
export class DiscardService {
  private readonly workspace = inject(WorkspaceService);
  private readonly editor = inject(EditorService);
  private readonly tabs = inject(TabsService);
  private readonly undo = inject(VaultUndoService);
  private readonly git = inject(GitService);

  /**
   * Asks, then discards. Returns false when the user declines. Typing that is still pending is
   * written first, so it is part of what Undo brings back and cannot overwrite the saved version
   * afterwards. Open tabs of the note read the disk again. Throws the message of the backend.
   */
  async discard(change: GitChange): Promise<boolean> {
    const root = this.workspace.vaultRoot();
    if (!root) return false;
    const ok = await ask(discardQuestion(change), {
      title: "Discard changes",
      okLabel: "Discard",
      kind: "warning",
    });
    if (!ok) return false;
    await this.editor.handle?.flush();
    try {
      await backend.gitDiscardNote(change.path, this.undo.author());
    } finally {
      await this.workspace.reloadTree();
      await this.git.refresh();
    }
    await this.tabs.onExternalChange(joinPath(root, change.path));
    await this.undo.offer();
    return true;
  }
}

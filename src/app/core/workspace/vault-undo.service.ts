import { Injectable, inject, signal } from "@angular/core";

import type { GitAuthor, VaultOperation } from "../file/backend";
import { backend } from "../file/backend";
import { DocumentService } from "../file/document.service";
import { SettingsService } from "../settings/settings.service";
import { WorkspaceService } from "./workspace.service";

/** A message for the toast; `undo` is set when the toast offers Undo. */
export interface UndoNotice {
  text: string;
  undo: boolean;
  error: boolean;
}

/**
 * Undo of the last vault operation (#241). In a Git vault every rename, move, delete, merge and
 * extraction is one commit; `offer` looks for it after the operation and raises the notice that
 * the app shows as a toast with Undo, `undo` reverts it.
 */
@Injectable({ providedIn: "root" })
export class VaultUndoService {
  private readonly settings = inject(SettingsService);
  private readonly workspace = inject(WorkspaceService);
  private readonly doc = inject(DocumentService);

  /** Set to show a toast; the app clears it. */
  readonly notice = signal<UndoNotice | null>(null);

  /** The Git author of the settings for the commits of the operations. */
  author(): GitAuthor {
    return {
      name: this.settings.gitAuthorName().trim() || null,
      email: this.settings.gitAuthorEmail().trim() || null,
    };
  }

  /** Offers Undo for the operation that just ran; nothing happens without Git. */
  async offer(): Promise<void> {
    const op = await backend.lastVaultOperation().catch(() => null);
    if (op) this.notice.set({ text: op.message, undo: true, error: false });
  }

  /** Reverts the last operation; a conflict is refused with a message and changes nothing. */
  async undo(): Promise<VaultOperation | null> {
    try {
      const op = await backend.undoVaultOperation(this.author());
      await this.workspace.reloadTree();
      if (this.doc.path()) await this.doc.reload().catch(() => this.doc.close());
      this.notice.set({ text: `Undone: ${op.message}`, undo: false, error: false });
      return op;
    } catch (e) {
      this.notice.set({ text: String(e), undo: false, error: true });
      return null;
    }
  }
}

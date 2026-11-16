import { Injectable, inject, signal } from "@angular/core";

import { DocumentService } from "../file/document.service";
import { dirname } from "../markdown/paths";
import { WorkspaceService } from "../workspace/workspace.service";

/** What the open editor offers to the app. */
export interface EditorHandle {
  /** 1-based first visible line. */
  topLine(): number;
  /** Writes pending changes at once. */
  flush(): Promise<void>;
}

/** Switches between the viewer and the editor of the open note. */
@Injectable({ providedIn: "root" })
export class EditorService {
  private readonly doc = inject(DocumentService);
  private readonly workspace = inject(WorkspaceService);

  readonly editing = signal(false);
  /** 1-based line the editor scrolls to when it opens. */
  readonly startLine = signal<number | null>(null);
  handle: EditorHandle | null = null;

  /**
   * Directory tree a write of `path` may reach: the vault root when the note lies in it, else the
   * note's own folder.
   */
  rootFor(path: string): string {
    const vault = this.workspace.vaultRoot();
    if (vault && path.startsWith(`${vault.replace(/\/$/, "")}/`)) return vault;
    return dirname(path);
  }

  /** `viewerLine`: the 1-based line at the top of the viewer, mapped to the editor. */
  async toggle(viewerLine: number | null): Promise<void> {
    if (!this.editing()) {
      if (!this.doc.path()) return;
      this.startLine.set(viewerLine);
      this.editing.set(true);
      return;
    }
    const handle = this.handle;
    const line = handle?.topLine() ?? null;
    await handle?.flush();
    this.doc.pendingLine.set(line);
    this.editing.set(false);
  }
}

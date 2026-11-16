import { Injectable, inject, signal } from "@angular/core";

import { DocumentService } from "../file/document.service";
import { backend } from "../file/backend";

/** What the open editor offers to the app. */
export interface EditorHandle {
  /** 1-based first visible line. */
  topLine(): number;
  /** Writes pending changes at once. */
  flush(): Promise<void>;
  /** True while an external change waits for the user's choice (reload or keep mine). */
  blocked(): boolean;
}

/** Switches between the viewer and the editor of the open note. */
@Injectable({ providedIn: "root" })
export class EditorService {
  private readonly doc = inject(DocumentService);

  readonly editing = signal(false);
  /** True while an external change blocks closing the editor; mirrors the open editor's conflict. */
  readonly blocked = signal(false);
  /** 1-based line the editor scrolls to when it opens. */
  readonly startLine = signal<number | null>(null);
  handle: EditorHandle | null = null;

  /** `viewerLine`: the 1-based line at the top of the viewer, mapped to the editor. */
  async toggle(viewerLine: number | null): Promise<void> {
    if (!this.editing()) {
      const path = this.doc.path();
      if (!path) return;
      if (!(await backend.isUtf8File(path))) {
        throw new Error("This note is not valid UTF-8; editing it would damage it.");
      }
      this.startLine.set(viewerLine);
      this.editing.set(true);
      return;
    }
    const handle = this.handle;
    if (handle?.blocked()) throw new Error("The note changed on disk: choose Reload or Keep mine first.");
    const line = handle?.topLine() ?? null;
    await handle?.flush();
    this.doc.pendingLine.set(line);
    this.editing.set(false);
  }
}

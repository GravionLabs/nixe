import { Injectable, inject, signal } from "@angular/core";

import { DocumentService } from "../file/document.service";
import { backend } from "../file/backend";
import type { TextStats } from "./text-stats";

/** What the open editor offers to the app. */
export interface EditorHandle {
  /** 1-based first visible line. */
  topLine(): number;
  /** Moves the editor to a 1-based line. */
  scrollToLine(line: number): void;
  /** Writes pending changes at once. */
  flush(): Promise<void>;
  /** True while changed text is not written (a failed or held save). */
  dirty(): boolean;
  /** True while an external change waits for the user's choice (reload or keep mine). */
  blocked(): boolean;
  /** Writes the text in the editor to a copy next to the note (the note itself is gone). */
  saveCopy(): Promise<void>;
  /** Inserts an expanded template at the cursor and merges its frontmatter into the note's. */
  insertTemplate(template: string): void;
  /** Brings dropped files into the vault and inserts `![[name]]` links at the cursor. */
  attachPaths(paths: string[]): Promise<void>;
  /** The selected text with its UTF-16 offsets; null when nothing is selected. */
  selection?(): { start: number; end: number; text: string } | null;
  /** 1-based line of the heading that holds the cursor; null before the first heading. */
  headingLine?(): number | null;
  /** Folds or unfolds at the cursor, or every foldable part of the note. */
  fold?(action: "fold" | "unfold" | "fold-all" | "unfold-all"): void;
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
  /** Words and characters of the open editor (its selection when there is one); null when none is open. */
  readonly stats = signal<TextStats | null>(null);
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
    if (handle?.blocked())
      throw new Error("The note changed on disk: choose Reload or Keep mine first.");
    const line = handle?.topLine() ?? null;
    await handle?.flush();
    this.doc.pendingLine.set(line);
    this.editing.set(false);
  }
}

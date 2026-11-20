import { Injectable, effect, inject, signal, untracked } from "@angular/core";

import type { ConflictPair } from "../file/backend";
import { backend } from "../file/backend";
import { DocumentService } from "../file/document.service";
import { EditorService } from "../editor/editor.service";
import { IndexService } from "../index/index.service";
import { WorkspaceService } from "../workspace/workspace.service";

/** The sync conflict the open note belongs to, and the two ways to settle it. */
@Injectable({ providedIn: "root" })
export class ConflictService {
  private readonly doc = inject(DocumentService);
  private readonly editor = inject(EditorService);
  private readonly index = inject(IndexService);
  private readonly workspace = inject(WorkspaceService);

  /** The pair of the open note; null when it is no part of a conflict. */
  readonly pair = signal<ConflictPair | null>(null);
  /** The two texts of an open merge; null when none is open. */
  readonly merging = signal<{ mine: string; theirs: string } | null>(null);
  private request = 0;

  constructor() {
    effect(() => {
      const path = this.doc.path();
      this.index.revision();
      untracked(() => void this.refresh(path));
    });
  }

  /** True when the open note is the copy (the local version) of the pair. */
  isCopy(): boolean {
    const pair = this.pair();
    return pair !== null && pair.copy === this.doc.path();
  }

  /** The other half of the pair, to open it. */
  other(): string | null {
    const pair = this.pair();
    return pair ? (this.isCopy() ? pair.original : pair.copy) : null;
  }

  async refresh(path: string | null = this.doc.path()): Promise<void> {
    const request = ++this.request;
    let pair: ConflictPair | null = null;
    if (path) {
      try {
        pair = await backend.conflictPair(path);
      } catch {
        pair = null;
      }
    }
    if (request === this.request) this.pair.set(pair);
  }

  async openOther(): Promise<void> {
    const other = this.other();
    if (other) await this.doc.open(other);
  }

  /**
   * Keeps this note's text (`this`) or the other one's (`other`). The original gets the text, the
   * copy moves to `.trash/` and the original is shown.
   */
  async keep(which: "this" | "other"): Promise<void> {
    const path = this.doc.path();
    if (!path || !this.pair()) return;
    // Pending text is written first, so the editor cannot write it over the result.
    await this.editor.handle?.flush();
    const original = await backend.resolveConflict(path, which);
    this.editor.editing.set(false);
    await this.doc.open(original, { addToHistory: false });
    await this.workspace.reloadTree();
    await this.refresh(original);
  }

  /** Opens the side-by-side merge of this note (`mine`) and the other one (`theirs`). */
  async startMerge(): Promise<void> {
    const path = this.doc.path();
    const other = this.other();
    if (!path || !other) return;
    await this.editor.handle?.flush();
    const [mine, theirs] = await Promise.all([
      backend.readTextFile(path),
      backend.readTextFile(other),
    ]);
    this.merging.set({ mine, theirs });
  }

  /** Leaves the merge without changing a file. */
  cancelMerge(): void {
    this.merging.set(null);
  }

  /** Writes the merged text to the original, moves the copy to `.trash/` and shows the original. */
  async saveMerge(text: string): Promise<void> {
    const path = this.doc.path();
    const pair = this.pair();
    if (!path || !pair) return;
    await this.doc.write(pair.original, text);
    const original = await backend.resolveConflict(pair.original, "this");
    this.merging.set(null);
    this.editor.editing.set(false);
    await this.doc.open(original, { addToHistory: false });
    await this.workspace.reloadTree();
    await this.refresh(original);
  }
}

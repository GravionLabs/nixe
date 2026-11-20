import { Injectable, computed, inject, signal } from "@angular/core";

import { DocumentService } from "../file/document.service";
import { buildOutline, collapseToLevel, currentHeading, markedHeading, outlineOf } from "./outline-core";

const NONE: ReadonlySet<number> = new Set();

/** The headings of the open note, and where the reader is in it. */
@Injectable({ providedIn: "root" })
export class OutlineService {
  private readonly doc = inject(DocumentService);

  /** 1-based first visible line of the viewer or the editor; set by whichever shows the note. */
  readonly topLine = signal<number | null>(null);
  /** The text in the editor while it is open, so the outline follows typing before it is saved. */
  readonly editorText = signal<string | null>(null);

  readonly headings = computed(() => outlineOf(this.editorText() ?? this.doc.content()));
  readonly tree = computed(() => buildOutline(this.headings()));
  readonly current = computed(() => currentHeading(this.headings(), this.topLine()));

  private readonly fold = signal<{ path: string | null; set: ReadonlySet<number> }>({ path: null, set: new Set() });
  /** Headings that are folded: their children are hidden. A fold belongs to the note it was made in. */
  readonly folded = computed<ReadonlySet<number>>(() => (this.fold().path === this.doc.path() ? this.fold().set : NONE));
  /** The heading to mark: the current one, or its outermost folded ancestor while it is hidden. */
  readonly marked = computed(() => markedHeading(this.tree(), this.current(), this.folded()));

  toggle(index: number): void {
    const next = new Set(this.folded());
    if (!next.delete(index)) next.add(index);
    this.fold.set({ path: this.doc.path(), set: next });
  }

  /** Shows the headings down to `level` (1 to 3) only. */
  collapseTo(level: number): void {
    this.fold.set({ path: this.doc.path(), set: collapseToLevel(this.tree(), level) });
  }

  expandAll(): void {
    this.fold.set({ path: this.doc.path(), set: NONE });
  }
}

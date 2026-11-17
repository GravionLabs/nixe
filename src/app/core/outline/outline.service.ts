import { Injectable, computed, inject, signal } from "@angular/core";

import { DocumentService } from "../file/document.service";
import { buildOutline, currentHeading, outlineOf } from "./outline-core";

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
}

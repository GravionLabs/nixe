import { Injectable, computed, inject, signal } from "@angular/core";

import type { RelatedNote } from "../file/backend";
import { backend } from "../file/backend";
import { BacklinksService } from "./backlinks.service";
import { IndexService } from "./index.service";

/** Notes close to the open note, ranked by the vault index. */
@Injectable({ providedIn: "root" })
export class RelatedService {
  private readonly links = inject(BacklinksService);
  private readonly index = inject(IndexService);

  readonly notes = signal<RelatedNote[]>([]);
  private readonly failed = signal(false);
  private request = 0;

  /** `idle` outside a note, `loading` while the index is built. */
  readonly state = computed<"idle" | "loading" | "error" | "ready">(() => {
    if (this.links.notePath() === null) return "idle";
    const status = this.index.status().state;
    if (status === "error" || this.failed()) return "error";
    return status === "ready" ? "ready" : "loading";
  });

  /** Changes whenever the list must be read again. */
  readonly key = this.links.key;

  /** Reads the related notes of the open note. A newer call wins over an older one still running. */
  async refresh(): Promise<void> {
    const request = ++this.request;
    const path = this.links.notePath();
    if (path === null || this.index.status().state !== "ready") {
      this.notes.set([]);
      this.failed.set(false);
      return;
    }
    try {
      const found = await backend.relatedNotes(path);
      if (request !== this.request) return;
      this.notes.set(found);
      this.failed.set(false);
    } catch {
      if (request !== this.request) return;
      this.notes.set([]);
      this.failed.set(true);
    }
  }
}

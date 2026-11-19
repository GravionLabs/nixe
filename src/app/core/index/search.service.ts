import { Injectable, computed, inject, signal } from "@angular/core";

import { SearchHit, backend } from "../file/backend";
import { IndexService } from "./index.service";

export type SearchState = "idle" | "loading" | "error" | "ready";

/** Vault-wide search over the index; one query at a time, the newest one wins. */
@Injectable({ providedIn: "root" })
export class SearchService {
  private readonly index = inject(IndexService);

  readonly query = signal("");
  readonly hits = signal<SearchHit[]>([]);
  private readonly failed = signal(false);
  private request = 0;

  readonly state = computed<SearchState>(() => {
    const status = this.index.status().state;
    if (status === "error" || this.failed()) return "error";
    if (status !== "ready") return "loading";
    return this.query().trim() ? "ready" : "idle";
  });

  /** Changes whenever the results must be read again: the index finished or was updated. */
  readonly key = computed(() => `${this.index.status().state}|${this.index.revision()}`);

  /** Sets the query to run, when there is one. */
  openWith(query?: string): void {
    if (query !== undefined) void this.setQuery(query);
  }

  async setQuery(query: string): Promise<void> {
    this.query.set(query);
    await this.refresh();
  }

  async refresh(): Promise<void> {
    const request = ++this.request;
    const query = this.query().trim();
    if (!query || this.index.status().state !== "ready") {
      this.hits.set([]);
      this.failed.set(false);
      return;
    }
    try {
      const hits = await backend.searchNotes(query);
      if (request !== this.request) return;
      this.hits.set(hits);
      this.failed.set(false);
    } catch {
      if (request !== this.request) return;
      this.hits.set([]);
      this.failed.set(true);
    }
  }
}

export interface Segment {
  text: string;
  match: boolean;
}

/** Splits a snippet at the \u0001 … \u0002 markers the backend puts around matches. */
export function segments(text: string): Segment[] {
  const out: Segment[] = [];
  let match = false;
  for (const part of text.split(/[\u0001\u0002]/u)) {
    // split drops the separators, so the kind alternates: text, match, text, …
    if (part) out.push({ text: part, match });
    match = !match;
  }
  return out;
}

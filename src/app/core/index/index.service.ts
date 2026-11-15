import { Injectable, signal } from "@angular/core";
import { listen } from "@tauri-apps/api/event";

import { INDEX_EVENT, IndexStatus, VAULT_CHANGED_EVENT, backend } from "../file/backend";

/** State of the vault index: build progress and a counter that moves whenever notes changed. */
@Injectable({ providedIn: "root" })
export class IndexService {
  readonly status = signal<IndexStatus>({ state: "idle", done: 0, total: 0, notes: 0, error: null });
  /** Incremented after the index applied a batch of vault changes. */
  readonly revision = signal(0);

  /** Subscribes to the index events. Never throws: without an index the app still works. */
  async init(): Promise<void> {
    try {
      await listen<IndexStatus>(INDEX_EVENT, (e) => this.status.set(e.payload));
      await listen(VAULT_CHANGED_EVENT, () => this.revision.update((n) => n + 1));
      this.status.set(await backend.indexStatus());
    } catch (err) {
      console.warn("index events unavailable", err);
    }
  }
}

import { Injectable, computed, inject, signal } from "@angular/core";

import { backend } from "../file/backend";
import { WorkspaceService } from "../workspace/workspace.service";
import { SwitcherEntry, SwitcherMatch, fileLabel, rank } from "./fuzzy";

const MAX_RECENT = 50;
const MAX_RESULTS = 50;

/** Quick switcher state: the notes of the vault, the query and the ranked matches. */
@Injectable({ providedIn: "root" })
export class SwitcherService {
  private readonly workspace = inject(WorkspaceService);

  readonly visible = signal(false);
  readonly query = signal("");
  readonly selected = signal(0);
  private readonly entries = signal<SwitcherEntry[]>([]);
  /** Vault-relative paths of opened notes, newest first. */
  private readonly opened = signal<{ root: string; rel: string }[]>([]);
  /** The recently opened notes of the current vault (vault-relative paths), newest first. */
  readonly recentNotes = computed(() => {
    const root = this.workspace.vaultRoot();
    return this.opened().filter((o) => o.root === root).map((o) => o.rel);
  });

  private readonly ranked = computed(() => rank(this.entries(), this.query(), this.recentNotes()));
  readonly matches = computed<SwitcherMatch[]>(() => this.ranked().slice(0, MAX_RESULTS));
  /** True when more notes match than the list shows. */
  readonly truncated = computed(() => this.ranked().length > MAX_RESULTS);

  async open(): Promise<void> {
    this.query.set("");
    this.selected.set(0);
    this.visible.set(true);
    this.entries.set(await this.loadEntries());
  }

  close(): void {
    this.visible.set(false);
  }

  setQuery(query: string): void {
    this.query.set(query);
    this.selected.set(0);
  }

  /** Moves the selection, wrapping around. */
  move(delta: number): void {
    const n = this.matches().length;
    if (n) this.selected.update((i) => (i + delta + n) % n);
  }

  /** The match Enter would open; null when nothing matches. */
  current(): SwitcherMatch | null {
    return this.matches()[this.selected()] ?? null;
  }

  /** Records an opened note (absolute path); notes outside the vault are ignored. */
  noteOpened(absolutePath: string): void {
    const root = this.workspace.vaultRoot();
    if (!root || !absolutePath.startsWith(root + "/")) return;
    const rel = absolutePath.slice(root.length + 1);
    this.opened.update((r) => [{ root, rel }, ...r.filter((o) => o.root !== root || o.rel !== rel)].slice(0, MAX_RECENT));
  }

  private async loadEntries(): Promise<SwitcherEntry[]> {
    try {
      const notes = await backend.notes();
      if (notes.length) return notes;
    } catch {
      // The index is not ready or unavailable: fall back to the file list without aliases.
    }
    return (this.workspace.vaultFiles() ?? [])
      .filter((p) => /\.md$/iu.test(p))
      .map((path) => ({ path, title: fileLabel(path), aliases: [] }));
  }
}

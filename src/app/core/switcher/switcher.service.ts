import { Injectable, computed, inject, signal } from "@angular/core";

import { backend } from "../file/backend";
import { WorkspaceService } from "../workspace/workspace.service";
import { WorkspacesService } from "../workspace/workspaces.service";
import type { SwitcherEntry, SwitcherMatch } from "./fuzzy";
import { fileLabel, rank, splitRootFilter } from "./fuzzy";

const MAX_RECENT = 50;
const MAX_RESULTS = 50;

/** The notes the palette finds without a prefix: the vault index, the recently opened notes. */
@Injectable({ providedIn: "root" })
export class SwitcherService {
  private readonly workspace = inject(WorkspaceService);
  private readonly workspaces = inject(WorkspacesService);

  private readonly entries = signal<SwitcherEntry[]>([]);
  /** Vault-relative paths of opened notes, newest first. */
  private readonly opened = signal<{ root: string; rel: string }[]>([]);
  /** The recently opened notes of the current vault (vault-relative paths), newest first. */
  readonly recentNotes = computed(() => {
    const root = this.workspace.vaultRoot();
    return this.opened()
      .filter((o) => o.root === root)
      .map((o) => o.rel);
  });

  /** The notes matching `query`, best first, cut to the list length; empty query: recent notes first. */
  search(query: string): { matches: SwitcherMatch[]; truncated: boolean } {
    // `root:name` narrows the list to the notes of that root (#117).
    const { roots, text } = splitRootFilter(query);
    const entries = roots.length
      ? this.entries().filter((e) => e.root && roots.includes(e.root.toLowerCase()))
      : this.entries();
    const ranked = rank(entries, text, this.recentNotes());
    return { matches: ranked.slice(0, MAX_RESULTS), truncated: ranked.length > MAX_RESULTS };
  }

  /** Loads the notes of the vault (or of all roots of the workspace) for the quick switcher. */
  async load(): Promise<void> {
    this.entries.set(await this.loadEntries());
  }

  /** Records an opened note (absolute path); notes outside the vault are ignored. */
  noteOpened(absolutePath: string): void {
    const root = this.workspace.vaultRoot();
    if (!root || !absolutePath.startsWith(`${root}/`)) return;
    const rel = absolutePath.slice(root.length + 1);
    this.opened.update((r) =>
      [{ root, rel }, ...r.filter((o) => o.root !== root || o.rel !== rel)].slice(0, MAX_RECENT),
    );
  }

  private async loadEntries(): Promise<SwitcherEntry[]> {
    try {
      const roots = this.workspaces.searchRoots();
      if (roots) {
        const all = await backend.workspaceNotes(roots);
        if (all.length) return all;
      }
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

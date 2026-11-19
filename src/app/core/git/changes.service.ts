import { Injectable, computed, effect, inject, signal, untracked } from "@angular/core";

import { GitChange, backend } from "../file/backend";
import { DocumentService } from "../file/document.service";
import { joinPath } from "../markdown/paths";
import { WorkspaceService } from "../workspace/workspace.service";
import { GitService } from "./git.service";
import { relativeTo } from "./history.service";

export type RangeKind = "sync" | "yesterday" | "commit";

/** The two texts of a changed note across the range. */
export interface NoteDiff {
  path: string;
  oldText: string;
  newText: string;
}

const DAY_SECONDS = 86_400;

/**
 * What changed in the vault between two points (#107): the notes the last pull brought (status bar,
 * sidebar marker) and, for any range, the list of changed notes with their diffs.
 */
@Injectable({ providedIn: "root" })
export class ChangesService {
  private readonly git = inject(GitService);
  private readonly workspace = inject(WorkspaceService);
  private readonly doc = inject(DocumentService);

  /** The notes the last pull changed. */
  readonly pulled = signal<GitChange[]>([]);
  /** Notes of the last pull that were not opened since (vault-relative). */
  private readonly unseen = signal<ReadonlySet<string>>(new Set());
  /** Absolute paths of the unseen notes, as the sidebar tree has them. */
  readonly unseenPaths = computed(() => {
    const root = this.workspace.vaultRoot();
    const set = new Set<string>();
    if (root) for (const rel of this.unseen()) set.add(joinPath(root, rel));
    return set;
  });

  /** The range the list shows. */
  readonly kind = signal<RangeKind>("sync");
  readonly changes = signal<GitChange[]>([]);
  readonly message = signal<string | null>(null);
  readonly loading = signal(false);
  /** The commit the list starts at; null when there is no range yet. */
  readonly from = signal<string | null>(null);
  readonly selected = signal<string | null>(null);
  readonly diff = signal<NoteDiff | null>(null);
  private request = 0;
  private diffRequest = 0;

  constructor() {
    effect(() => {
      const pull = this.git.lastPull();
      if (pull) untracked(() => void this.recordPull(pull.from));
    });
    // Opening a note takes its marker away.
    effect(() => {
      const root = this.workspace.vaultRoot();
      const file = this.doc.path();
      const rel = root && file ? relativeTo(root, file) : null;
      if (rel === null) return;
      untracked(() => {
        if (!this.unseen().has(rel)) return;
        const next = new Set(this.unseen());
        next.delete(rel);
        this.unseen.set(next);
      });
    });
    // Another vault: nothing carries over.
    effect(() => {
      this.workspace.vaultRoot();
      untracked(() => {
        this.git.lastPull.set(null);
        this.pulled.set([]);
        this.unseen.set(new Set());
      });
    });
  }

  private async recordPull(from: string): Promise<void> {
    try {
      const list = await backend.gitChangesBetween(from);
      this.pulled.set(list);
      this.unseen.set(new Set(list.filter((c) => c.kind !== "deleted").map((c) => c.path)));
    } catch {
      this.pulled.set([]);
    }
  }

  /** Lists the notes changed since the last pull. */
  async showSync(): Promise<void> {
    const pull = this.git.lastPull();
    this.kind.set("sync");
    await this.load(pull ? pull.from : null, "No sync brought changes yet");
  }

  /** Lists the notes changed since 24 hours ago. */
  async showYesterday(now = Date.now()): Promise<void> {
    this.kind.set("yesterday");
    let from: string | null = null;
    try {
      from = await backend.gitRevAt(Math.floor(now / 1000) - DAY_SECONDS);
    } catch (err) {
      this.fail(err);
      return;
    }
    await this.load(from, "The history starts less than a day ago");
  }

  /** Lists the notes changed since the commit `rev` (an id or a prefix). */
  async showCommit(rev: string): Promise<void> {
    this.kind.set("commit");
    const value = rev.trim();
    if (!value) {
      this.reset("Enter a commit id");
      return;
    }
    await this.load(value, "");
  }

  private reset(message: string | null): void {
    ++this.request;
    this.changes.set([]);
    this.from.set(null);
    this.selected.set(null);
    this.diff.set(null);
    this.loading.set(false);
    this.message.set(message);
  }

  private fail(err: unknown): void {
    this.reset(String(err instanceof Error ? err.message : err));
  }

  private async load(from: string | null, none: string): Promise<void> {
    if (from === null) {
      this.reset(none);
      return;
    }
    this.reset(null);
    const request = this.request;
    this.loading.set(true);
    try {
      const list = await backend.gitChangesBetween(from);
      if (request !== this.request) return;
      this.from.set(from);
      this.changes.set(list);
      this.message.set(list.length === 0 ? "No notes changed" : null);
    } catch (err) {
      if (request === this.request) this.fail(err);
    } finally {
      if (request === this.request) this.loading.set(false);
    }
  }

  /** Shows or hides the diff of a note of the list. */
  async toggle(change: GitChange): Promise<void> {
    const from = this.from();
    if (from === null) return;
    if (this.selected() === change.path) {
      this.selected.set(null);
      this.diff.set(null);
      return;
    }
    const request = ++this.diffRequest;
    this.selected.set(change.path);
    this.diff.set(null);
    try {
      const [oldText, newText] = await Promise.all([
        backend.gitNoteVersion(change.path, from),
        backend.gitNoteVersion(change.path, "HEAD"),
      ]);
      if (request === this.diffRequest) this.diff.set({ path: change.path, oldText, newText });
    } catch (err) {
      if (request === this.diffRequest) this.message.set(String(err));
    }
  }
}

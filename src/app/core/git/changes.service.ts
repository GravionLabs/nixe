import { Injectable, computed, effect, inject, signal, untracked } from "@angular/core";

import type { GitChange, VaultCommit } from "../file/backend";
import { backend } from "../file/backend";
import { DocumentService } from "../file/document.service";
import { CompareService } from "../compare/compare.service";
import { basename, joinPath } from "../markdown/paths";
import { WorkspaceService } from "../workspace/workspace.service";
import { GitService } from "./git.service";
import { relativeTo } from "./history.service";

export type RangeKind = "sync" | "yesterday" | "week" | "commit";

/** How many versions the picker lists. */
export const VERSION_LIMIT = 100;

/** A version picked from the list: its commit and how it is named to the user. */
export interface ChosenVersion {
  id: string;
  label: string;
}

/** A commit's date as the picker shows it. */
export function versionDate(seconds: number): string {
  return new Date(seconds * 1000).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

const DAY_SECONDS = 86_400;
const WEEK_SECONDS = 7 * DAY_SECONDS;

/**
 * What changed in the vault between two points (#107): the notes the last pull brought (status bar,
 * sidebar marker) and, for any range, the list of changed notes with their diffs.
 */
@Injectable({ providedIn: "root" })
export class ChangesService {
  private readonly git = inject(GitService);
  private readonly workspace = inject(WorkspaceService);
  private readonly doc = inject(DocumentService);
  private readonly compareView = inject(CompareService);

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
  /** The version picked with "Choose a version…"; kept for the session. */
  readonly chosen = signal<ChosenVersion | null>(null);
  /** The versions of the vault the picker lists, newest first. */
  readonly versions = signal<VaultCommit[]>([]);
  readonly versionsError = signal<string | null>(null);
  private request = 0;

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
        this.chosen.set(null);
        this.versions.set([]);
        this.kind.set("sync");
        this.reset(null);
      });
    });
  }

  /** Reads the versions of the vault for the picker. */
  async loadVersions(): Promise<void> {
    try {
      this.versions.set(await backend.gitVaultLog(0, VERSION_LIMIT));
      this.versionsError.set(null);
    } catch (err) {
      this.versions.set([]);
      this.versionsError.set(String(err instanceof Error ? err.message : err));
    }
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
    await this.showAgo("yesterday", DAY_SECONDS, "The history starts less than a day ago", now);
  }

  /** Lists the notes changed since 7 days ago. */
  async showWeek(now = Date.now()): Promise<void> {
    await this.showAgo("week", WEEK_SECONDS, "The history starts less than a week ago", now);
  }

  private async showAgo(
    kind: RangeKind,
    seconds: number,
    none: string,
    now: number,
  ): Promise<void> {
    this.kind.set(kind);
    let from: string | null = null;
    try {
      from = await backend.gitRevAt(Math.floor(now / 1000) - seconds);
    } catch (err) {
      this.fail(err);
      return;
    }
    await this.load(from, none);
  }

  /** Switches to the version picker; the list of an earlier pick stays. */
  async chooseVersion(): Promise<void> {
    this.kind.set("commit");
    if (this.chosen() === null) this.reset(null);
    await this.loadVersions();
  }

  /** Lists the notes changed since the picked version (a commit id or a prefix). */
  async showCommit(rev: string, label?: string): Promise<void> {
    this.kind.set("commit");
    const value = rev.trim();
    if (!value) {
      this.chosen.set(null);
      this.reset("Choose a version");
      return;
    }
    this.chosen.set({ id: value, label: label ?? value.slice(0, 7) });
    await this.load(value, "");
  }

  /** Lists the notes changed since a version of the picker. */
  async showVersion(commit: VaultCommit): Promise<void> {
    await this.showCommit(commit.id, versionDate(commit.time));
  }

  private reset(message: string | null): void {
    ++this.request;
    this.changes.set([]);
    this.from.set(null);
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
      this.message.set(list.length === 0 ? `Nothing changed since ${this.sinceText()}` : null);
    } catch (err) {
      if (request === this.request) this.fail(err);
    } finally {
      if (request === this.request) this.loading.set(false);
    }
  }

  /** The label of the range start in the compare view. */
  private fromLabel(): string {
    const kind = this.kind();
    if (kind === "sync") return "Last sync";
    if (kind === "yesterday") return "Yesterday";
    if (kind === "week") return "Last week";
    return this.chosen()?.label ?? (this.from() ?? "").slice(0, 7);
  }

  /** The range start as the empty-range message names it. */
  private sinceText(): string {
    const kind = this.kind();
    if (kind === "sync") return "the last sync";
    if (kind === "yesterday") return "yesterday";
    if (kind === "week") return "last week";
    return this.chosen()?.label ?? (this.from() ?? "").slice(0, 7);
  }

  /** Opens the versions of a note of the list, before the range and now, in the compare view. */
  async compare(change: GitChange): Promise<void> {
    const from = this.from();
    if (from === null) return;
    try {
      const [oldText, newText] = await Promise.all([
        change.kind === "added" ? Promise.resolve(null) : backend.gitNoteVersion(change.path, from),
        change.kind === "deleted"
          ? Promise.resolve(null)
          : backend.gitNoteVersion(change.path, "HEAD"),
      ]);
      this.compareView.open({
        path: change.path,
        title: basename(change.path).replace(/\.(md|markdown|mdown|mkd)$/i, ""),
        oldLabel: this.fromLabel(),
        newLabel: "Now",
        oldText,
        newText,
      });
    } catch (err) {
      this.message.set(String(err));
    }
  }
}

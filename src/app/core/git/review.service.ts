import { Injectable, computed, effect, inject, signal, untracked } from "@angular/core";

import { GitChange, ReviewBranch, backend } from "../file/backend";
import { IndexService } from "../index/index.service";
import { SettingsService } from "../settings/settings.service";
import { GitService } from "./git.service";

/** The two texts of a note of a branch: the merge base and the branch tip. */
export interface ReviewDiff {
  path: string;
  oldText: string;
  newText: string;
}

/**
 * The inbox for changes an agent made on a branch (#108): the branches with the review prefix
 * that are ahead of the working branch, and per branch the notes it changed against the merge base.
 */
@Injectable({ providedIn: "root" })
export class ReviewService {
  private readonly git = inject(GitService);
  private readonly index = inject(IndexService);
  private readonly settings = inject(SettingsService);

  readonly branches = signal<ReviewBranch[]>([]);
  /** The number of branches waiting, for the status bar. */
  readonly count = computed(() => this.branches().length);
  readonly error = signal<string | null>(null);
  /** The branch that is open. */
  readonly open = signal<ReviewBranch | null>(null);
  readonly base = signal<string | null>(null);
  readonly changes = signal<GitChange[]>([]);
  readonly selected = signal<string | null>(null);
  readonly diff = signal<ReviewDiff | null>(null);
  readonly loading = signal(false);
  private request = 0;
  private branchRequest = 0;
  private diffRequest = 0;

  constructor() {
    effect(() => {
      this.git.available();
      this.git.status();
      this.index.revision();
      this.settings.reviewBranchPrefix();
      untracked(() => void this.refresh());
    });
  }

  /** Reads the waiting branches again. */
  async refresh(): Promise<void> {
    const request = ++this.request;
    const prefix = this.settings.reviewBranchPrefix();
    if (!this.git.available() || prefix === "") {
      this.branches.set([]);
      this.close();
      return;
    }
    try {
      const list = await backend.gitReviewBranches(prefix);
      if (request !== this.request) return;
      this.branches.set(list);
      this.error.set(null);
      // The open branch moved on (new tip) or is merged: follow it or close it.
      const open = this.open();
      if (open) {
        const now = list.find((b) => b.name === open.name);
        if (!now) this.close();
        else if (now.tip !== open.tip) void this.show(now);
      }
    } catch (err) {
      if (request === this.request) {
        this.branches.set([]);
        this.error.set(String(err instanceof Error ? err.message : err));
      }
    }
  }

  close(): void {
    ++this.branchRequest;
    ++this.diffRequest;
    this.open.set(null);
    this.base.set(null);
    this.changes.set([]);
    this.selected.set(null);
    this.diff.set(null);
    this.loading.set(false);
  }

  /** Opens a branch: lists its notes against the merge base. Opening the open one closes it. */
  async toggle(branch: ReviewBranch): Promise<void> {
    if (this.open()?.name === branch.name) {
      this.close();
      return;
    }
    await this.show(branch);
  }

  private async show(branch: ReviewBranch): Promise<void> {
    this.close();
    const request = this.branchRequest;
    this.open.set(branch);
    this.loading.set(true);
    try {
      const result = await backend.gitReviewChanges(branch.tip);
      if (request !== this.branchRequest) return;
      this.base.set(result.base);
      this.changes.set(result.changes);
    } catch (err) {
      if (request === this.branchRequest) this.error.set(String(err instanceof Error ? err.message : err));
    } finally {
      if (request === this.branchRequest) this.loading.set(false);
    }
  }

  /** Shows or hides the diff of one note of the open branch. */
  async select(change: GitChange): Promise<void> {
    const branch = this.open();
    const base = this.base();
    if (!branch || base === null) return;
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
        backend.gitNoteVersion(change.path, base),
        backend.gitNoteVersion(change.path, branch.tip),
      ]);
      if (request === this.diffRequest) this.diff.set({ path: change.path, oldText, newText });
    } catch (err) {
      if (request === this.diffRequest) this.error.set(String(err instanceof Error ? err.message : err));
    }
  }
}

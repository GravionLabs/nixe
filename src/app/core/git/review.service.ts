import { Injectable, computed, effect, inject, signal, untracked } from "@angular/core";

import type {
  GitChange,
  NoteDecision,
  ReviewBranch,
  ReviewConflict,
  ReviewHunk,
} from "../file/backend";
import { backend } from "../file/backend";
import { IndexService } from "../index/index.service";
import { SettingsService } from "../settings/settings.service";
import { GitService } from "./git.service";

/** The two texts of a note of a branch: the merge base and the branch tip. */
export interface ReviewDiff {
  path: string;
  oldText: string;
  newText: string;
}

/** What the user decided on one note of the open branch (#109). */
export interface NoteChoice {
  /** For a note without hunks. */
  accepted?: boolean;
  hunks: Record<number, { accept: boolean; text?: string }>;
  resolve?: "mine" | "branch";
}

export type NoteState = "accepted" | "rejected" | "partial";

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
  /** The hunks of every note of the open branch. */
  readonly hunks = signal<Record<string, ReviewHunk[]>>({});
  /** The decisions per note; a hunk without an entry is rejected. */
  readonly choices = signal<Record<string, NoteChoice>>({});
  /** Notes that did not merge cleanly in the last attempt to finish. */
  readonly conflicts = signal<ReviewConflict[]>([]);
  readonly finishing = signal(false);
  /** What the last finished review did, for the user. */
  readonly result = signal<string | null>(null);
  /** The notes with at least one accepted hunk. */
  readonly accepted = computed(
    () => this.changes().filter((c) => this.stateOf(c.path) !== "rejected").length,
  );
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
    this.hunks.set({});
    this.choices.set({});
    this.conflicts.set([]);
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
      const entries = await Promise.all(
        result.changes.map(
          async (c) => [c.path, await backend.gitReviewHunks(branch.tip, c.path)] as const,
        ),
      );
      const saved = await this.loadState(branch);
      if (request !== this.branchRequest) return;
      this.base.set(result.base);
      this.changes.set(result.changes);
      this.hunks.set(Object.fromEntries(entries));
      this.choices.set(saved);
    } catch (err) {
      if (request === this.branchRequest)
        this.error.set(String(err instanceof Error ? err.message : err));
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
      if (request === this.diffRequest)
        this.error.set(String(err instanceof Error ? err.message : err));
    }
  }

  /** The decisions saved for this branch, when the branch is still at the same tip. */
  private async loadState(branch: ReviewBranch): Promise<Record<string, NoteChoice>> {
    try {
      const text = await backend.gitReviewStateLoad(branch.name);
      if (!text) return {};
      const saved = JSON.parse(text) as { tip?: string; choices?: Record<string, NoteChoice> };
      return saved.tip === branch.tip && saved.choices ? saved.choices : {};
    } catch {
      return {};
    }
  }

  private set(choices: Record<string, NoteChoice>): void {
    this.choices.set(choices);
    const branch = this.open();
    if (!branch) return;
    const content = Object.keys(choices).length
      ? JSON.stringify({ tip: branch.tip, choices })
      : null;
    void backend.gitReviewStateSave(branch.name, content).catch(() => undefined);
  }

  /** Whether a hunk is accepted. */
  isAccepted(path: string, index: number): boolean {
    return this.choices()[path]?.hunks[index]?.accept === true;
  }

  /** The edited text of an accepted hunk, if any. */
  editedText(path: string, index: number): string | undefined {
    return this.choices()[path]?.hunks[index]?.text;
  }

  stateOf(path: string): NoteState {
    const hunks = this.hunks()[path] ?? [];
    if (hunks.length === 0) return this.choices()[path]?.accepted ? "accepted" : "rejected";
    const n = hunks.filter((h) => this.isAccepted(path, h.index)).length;
    return n === 0 ? "rejected" : n === hunks.length ? "accepted" : "partial";
  }

  /** Accepts or rejects a whole note (all its hunks). */
  setNote(path: string, accept: boolean): void {
    const hunks = this.hunks()[path] ?? [];
    const previous = this.choices()[path];
    const next: NoteChoice = { accepted: accept, hunks: {}, resolve: previous?.resolve };
    for (const h of hunks) {
      const kept = previous?.hunks[h.index];
      next.hunks[h.index] = {
        accept,
        ...(accept && kept?.text !== undefined ? { text: kept.text } : {}),
      };
    }
    this.set({ ...this.choices(), [path]: next });
  }

  setHunk(path: string, index: number, accept: boolean): void {
    const previous = this.choices()[path] ?? { hunks: {} };
    const kept = previous.hunks[index];
    this.set({
      ...this.choices(),
      [path]: {
        ...previous,
        hunks: {
          ...previous.hunks,
          [index]: { accept, ...(accept && kept?.text !== undefined ? { text: kept.text } : {}) },
        },
      },
    });
  }

  /** Replaces the lines of an accepted hunk; the empty text drops them. */
  editHunk(path: string, index: number, text: string): void {
    const previous = this.choices()[path] ?? { hunks: {} };
    this.set({
      ...this.choices(),
      [path]: { ...previous, hunks: { ...previous.hunks, [index]: { accept: true, text } } },
    });
  }

  /** Takes the edit back: the hunk applies as the branch has it. */
  resetHunk(path: string, index: number): void {
    const previous = this.choices()[path] ?? { hunks: {} };
    this.set({
      ...this.choices(),
      [path]: { ...previous, hunks: { ...previous.hunks, [index]: { accept: true } } },
    });
  }

  /** How a conflicting note ends: keep the vault version or take the branch version. */
  resolve(path: string, how: "mine" | "branch"): void {
    const previous = this.choices()[path] ?? { hunks: {} };
    this.set({ ...this.choices(), [path]: { ...previous, resolve: how } });
  }

  private decisions(): NoteDecision[] {
    const choices = this.choices();
    return this.changes().map((c) => {
      const choice = choices[c.path];
      const hunks = (this.hunks()[c.path] ?? []).flatMap((h) => {
        const d = choice?.hunks[h.index];
        return d?.accept
          ? [{ index: h.index, accept: true, ...(d.text !== undefined ? { text: d.text } : {}) }]
          : [];
      });
      return {
        path: c.path,
        accepted: choice?.accepted === true,
        hunks,
        ...(choice?.resolve ? { resolve: choice.resolve } : {}),
      };
    });
  }

  /**
   * Commits the accepted changes onto the working branch and deletes the branch locally and on
   * the remote (the caller has asked the user). Notes that do not merge cleanly are listed in
   * `conflicts` and nothing changes until each has a resolution.
   */
  async finish(): Promise<void> {
    const branch = this.open();
    if (!branch || this.finishing()) return;
    this.finishing.set(true);
    this.error.set(null);
    try {
      const out = await backend.gitReviewFinish(
        branch.name,
        branch.tip,
        this.decisions(),
        true,
        this.settings.gitAuthorName().trim() || null,
        this.settings.gitAuthorEmail().trim() || null,
      );
      if (out.conflicts.length > 0) {
        this.conflicts.set(out.conflicts);
        return;
      }
      const count = out.applied.length;
      const text =
        count === 0
          ? `Nothing accepted: ${branch.name} deleted without changes`
          : `${count} ${count === 1 ? "note" : "notes"} from ${branch.name} merged`;
      this.close();
      this.result.set(out.warning ? `${text}. ${out.warning}` : text);
      await this.git.refresh();
      await this.refresh();
    } catch (err) {
      this.error.set(String(err instanceof Error ? err.message : err));
    } finally {
      this.finishing.set(false);
    }
  }
}

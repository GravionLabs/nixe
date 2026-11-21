// The Git side of the demo backend (#403): a seeded history of the demo vault, the working-tree
// status, a branch that waits for review and the commit and sync commands. It is no port of the
// Rust core: the history is data, and a commit only records the open changes.
import type {
  ConflictPair,
  DeletedNote,
  GitChange,
  GitStatus,
  HistoryEntry,
  NoteDecision,
  RecentNote,
  ReviewBranch,
  ReviewChanges,
  ReviewHunk,
  ReviewOutcome,
  SyncReport,
  VaultCommit,
} from "../../app/core/file/backend";
import { NOTES } from "./data";
import type { DemoVault } from "./vault";

/** What one commit did to one note. */
interface FileChange {
  kind: GitChange["kind"];
  /** The note after the commit; empty for a deletion. */
  text: string;
}

interface SeedCommit {
  author: string;
  /** Seconds before the clock of the demo. */
  ago: number;
  message: string;
  operation?: string;
  files: Record<string, FileChange>;
}

const HOUR = 3600;
const DAY = 24 * HOUR;

/** Oldest first. The last commit is HEAD; the notes of the vault differ from it in `WORKING_CHANGES`. */
const COMMITS: SeedCommit[] = [
  {
    author: "Ada Demo",
    ago: 30 * DAY,
    message: "init: the demo vault",
    files: {
      "Home.md": {
        kind: "added",
        text: "# Home\n\nWelcome. See [[Projects/Nixe]].\n",
      },
      "Ideas.md": { kind: "added", text: "# Ideas\n\n- [ ] A graph of the notes\n" },
      "Projects/Nixe.md": { kind: "added", text: "# Nixe\n\nA Markdown vault app.\n" },
      "Projects/Helix.md": { kind: "added", text: "# Helix\n\nThe design system of Nixe.\n" },
    },
  },
  {
    author: "Ada Demo",
    ago: 21 * DAY,
    message: "docs: describe Nixe",
    files: { "Projects/Nixe.md": { kind: "modified", text: NOTES["Projects/Nixe.md"]! } },
  },
  {
    author: "Ben Demo",
    ago: 14 * DAY,
    message: "chore: scratch note",
    files: { "Scratch.md": { kind: "added", text: "# Scratch\n\nThrow-away thoughts.\n" } },
  },
  {
    author: "Ben Demo",
    ago: 13 * DAY,
    message: "delete: Scratch",
    operation: "delete",
    files: { "Scratch.md": { kind: "deleted", text: "" } },
  },
  {
    author: "Ada Demo",
    ago: 5 * DAY,
    message: "docs: link the home note",
    files: {
      "Home.md": { kind: "modified", text: NOTES["Home.md"]! },
      "Projects/Helix.md": { kind: "modified", text: NOTES["Projects/Helix.md"]! },
    },
  },
  {
    author: "Ben Demo",
    ago: 2 * HOUR,
    message: "ideas: tick the backlinks",
    files: {
      "Ideas.md": {
        kind: "modified",
        text: "# Ideas\n\n- [ ] A graph of the notes\n- [ ] Backlinks in the side panel\n",
      },
    },
  },
];

/** The notes the working tree changed after HEAD. */
const WORKING_CHANGES: GitChange[] = [
  { path: "Ideas.md", kind: "modified" },
  { path: "Daily/2026-11-21.md", kind: "added", untracked: true },
];

const REVIEW_BRANCH = "claude/tidy-inbox";
const REVIEW_HOME_OLD = "- [[Ideas]]: things to try\n";
const REVIEW_HOME_NEW = "- [[Ideas]]: things to try next\n";
const REVIEW_ROADMAP = "# Roadmap\n\n- Ship the demo\n";

const sha = (n: number): string => `5eed${n.toString(16).padStart(2, "0")}`.padEnd(40, "0");

export class DemoGit {
  private readonly commits: (Omit<SeedCommit, "ago"> & { id: string; time: number })[];
  private readonly open: GitChange[] = structuredClone(WORKING_CHANGES);
  private readonly states = new Map<string, string>();
  private reviewOpen = true;
  private extraCommits = 0;
  private ahead = 1;

  /**
   * @param clock the clock of the demo in milliseconds; the commits are placed before it
   */
  constructor(
    private readonly vault: DemoVault,
    clock: number,
  ) {
    this.commits = COMMITS.map((c, i) => ({
      id: sha(i + 1),
      author: c.author,
      time: Math.floor(clock / 1000) - c.ago,
      message: c.message,
      operation: c.operation,
      files: c.files,
    }));
  }

  private get head(): string {
    return this.commits[this.commits.length - 1]!.id;
  }

  private indexOf(rev: string): number {
    const at = this.commits.findIndex((c) => c.id === rev);
    if (at < 0) throw `unknown revision ${rev}`;
    return at;
  }

  status(): GitStatus {
    return {
      branch: "main",
      changes: structuredClone(this.open),
      ahead: this.ahead,
      behind: 0,
      hasRemote: true,
    };
  }

  log(offset: number, limit: number): VaultCommit[] {
    return [...this.commits]
      .reverse()
      .slice(offset, offset + limit)
      .map(({ id, author, time, message }) => ({ id, author, time, message }));
  }

  noteHistory(path: string, offset: number, limit: number): HistoryEntry[] {
    const entries: HistoryEntry[] = [];
    this.commits.forEach((c, i) => {
      if (!c.files[path]) return;
      entries.push({
        id: c.id,
        author: c.author,
        time: c.time,
        message: c.message,
        path,
        parent: i === 0 ? null : this.commits[i - 1]!.id,
        parentPath: path,
        operation: c.operation ?? null,
      });
    });
    return entries.reverse().slice(offset, offset + limit);
  }

  /** The note at a commit, empty when it did not exist there; `null` is the file on disk. */
  noteVersion(path: string, rev: string | null): string {
    if (rev === null)
      return this.vault.isFile(this.abs(path)) ? this.vault.read(this.abs(path)) : "";
    let text = "";
    for (const c of this.commits.slice(0, this.indexOf(rev) + 1)) {
      const file = c.files[path];
      if (file) text = file.text;
    }
    return text;
  }

  /** The notes that differ between `from` and `to` (HEAD when null). */
  changesBetween(from: string, to: string | null): GitChange[] {
    const end = to === null ? this.commits.length - 1 : this.indexOf(to);
    const changes = new Map<string, GitChange>();
    for (const c of this.commits.slice(this.indexOf(from) + 1, end + 1)) {
      for (const [path, file] of Object.entries(c.files)) {
        const before = changes.get(path);
        // A note added and deleted inside the range left no change.
        if (before?.kind === "added" && file.kind === "deleted") changes.delete(path);
        else changes.set(path, { path, kind: before?.kind === "added" ? "added" : file.kind });
      }
    }
    return [...changes.values()];
  }

  /** The newest commit at or before `time` (seconds). */
  revAt(time: number): string | null {
    const found = [...this.commits].reverse().find((c) => c.time <= time);
    return found?.id ?? null;
  }

  deletedNotes(commits: number): DeletedNote[] {
    const out: DeletedNote[] = [];
    const from = Math.max(0, this.commits.length - commits);
    for (let i = this.commits.length - 1; i >= from; i--) {
      const c = this.commits[i]!;
      for (const [path, file] of Object.entries(c.files)) {
        if (file.kind === "deleted" && !this.vault.isFile(this.abs(path))) {
          out.push({
            path,
            id: c.id,
            parent: this.commits[i - 1]?.id ?? c.id,
            author: c.author,
            time: c.time,
            message: c.message,
          });
        }
      }
    }
    return out;
  }

  recentNotes(commits: number, limit: number): RecentNote[] {
    const out: RecentNote[] = [];
    const seen = new Set<string>();
    const from = Math.max(0, this.commits.length - commits);
    for (let i = this.commits.length - 1; i >= from; i--) {
      const c = this.commits[i]!;
      for (const [path, file] of Object.entries(c.files)) {
        if (file.kind === "deleted" || seen.has(path) || !this.vault.isFile(this.abs(path)))
          continue;
        seen.add(path);
        out.push({ path, id: c.id, author: c.author, time: c.time, message: c.message });
      }
    }
    return out.slice(0, limit);
  }

  reviewBranches(prefix: string): ReviewBranch[] {
    if (!this.reviewOpen || !REVIEW_BRANCH.startsWith(prefix)) return [];
    const tip = this.reviewTip();
    return [
      {
        name: REVIEW_BRANCH,
        tip,
        remote: true,
        author: "Claude",
        time: this.commits[this.commits.length - 1]!.time + HOUR,
        messages: ["tidy: link the roadmap from the home note", "docs: add a roadmap note"],
        ahead: 2,
        notes: 2,
      },
    ];
  }

  private reviewTip(): string {
    return sha(0xb0);
  }

  reviewChanges(rev: string): ReviewChanges {
    if (rev !== this.reviewTip()) throw `unknown revision ${rev}`;
    return {
      base: this.head,
      changes: [
        { path: "Home.md", kind: "modified" },
        { path: "Projects/Roadmap.md", kind: "added" },
      ],
    };
  }

  reviewHunks(tip: string, path: string): ReviewHunk[] {
    if (tip !== this.reviewTip()) throw `unknown revision ${tip}`;
    if (path !== "Home.md") return [];
    const lines = NOTES["Home.md"]!.split("\n");
    const at = lines.indexOf(REVIEW_HOME_OLD.trimEnd());
    return [
      {
        index: 0,
        oldStart: at + 1,
        oldLines: 1,
        newStart: at + 1,
        newLines: 1,
        old: REVIEW_HOME_OLD,
        new: REVIEW_HOME_NEW,
      },
    ];
  }

  reviewFinish(branch: string, decisions: NoteDecision[], deleteBranch: boolean): ReviewOutcome {
    if (branch !== REVIEW_BRANCH) throw `unknown branch ${branch}`;
    const applied: string[] = [];
    for (const d of decisions) {
      const abs = this.abs(d.path);
      if (d.path === "Home.md" && d.hunks.some((h) => h.accept)) {
        const hunk = d.hunks.find((h) => h.accept)!;
        this.vault.write(
          abs,
          this.vault.read(abs).replace(REVIEW_HOME_OLD, hunk.text ?? REVIEW_HOME_NEW),
        );
        applied.push(d.path);
      } else if (d.path === "Projects/Roadmap.md" && d.accepted) {
        this.vault.write(abs, REVIEW_ROADMAP);
        applied.push(d.path);
      }
    }
    if (deleteBranch) this.reviewOpen = false;
    const commit = applied.length
      ? this.record("review: apply the accepted changes", applied)
      : null;
    return { commit, applied, conflicts: [], branchDeleted: deleteBranch, warning: null };
  }

  reviewStateLoad(branch: string): string | null {
    return this.states.get(branch) ?? null;
  }

  reviewStateSave(branch: string, content: string | null): void {
    if (content === null) this.states.delete(branch);
    else this.states.set(branch, content);
  }

  /** Commits the open changes (all of them, or those of `paths`). */
  commit(message: string | null, paths: string[] | null): string {
    const taken = paths ? this.open.filter((c) => paths.includes(c.path)) : [...this.open];
    return this.record(
      message?.trim() || "vault backup: demo",
      taken.map((c) => c.path),
    );
  }

  private record(message: string, paths: string[]): string {
    const id = sha(0xc0 + this.extraCommits++);
    this.commits.push({
      id,
      author: "You",
      time: this.commits[this.commits.length - 1]!.time + 60,
      message,
      files: Object.fromEntries(
        paths.map((path) => [
          path,
          {
            kind: this.open.find((c) => c.path === path)?.kind ?? "modified",
            text: this.vault.isFile(this.abs(path)) ? this.vault.read(this.abs(path)) : "",
          },
        ]),
      ),
    });
    for (const path of paths) {
      const at = this.open.findIndex((c) => c.path === path);
      if (at >= 0) this.open.splice(at, 1);
    }
    this.ahead++;
    return id;
  }

  /** A sync with a remote that has nothing new: it commits, pushes and ends. */
  sync(): SyncReport {
    const committed = this.open.length > 0;
    if (committed) this.commit(null, null);
    this.ahead = 0;
    return { committed, pulled: false, pushed: true, pulledFrom: null, conflicts: [] };
  }

  /** The demo has no conflicting copies. */
  conflictPair(): ConflictPair | null {
    return null;
  }

  private abs(path: string): string {
    return `${this.vault.root}/${path}`;
  }
}

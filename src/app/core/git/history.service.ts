import { Injectable, computed, effect, inject, signal, untracked } from "@angular/core";

import type { DeletedNote, HistoryEntry } from "../file/backend";
import { backend } from "../file/backend";
import { EditorService } from "../editor/editor.service";
import { DocumentService } from "../file/document.service";
import { IndexService } from "../index/index.service";
import { toSlashes } from "../markdown/paths";
import { WorkspaceService } from "../workspace/workspace.service";
import { GitService } from "./git.service";

export const PAGE_SIZE = 50;
/** How many of the latest commits are searched for deleted notes. */
export const DELETED_COMMITS = 50;

/** A row of the timeline: a commit, or the uncommitted state (`id` null). */
export interface TimelineEntry {
  id: string | null;
  author: string;
  time: number;
  message: string;
  path: string;
  /** The vault operation that wrote the commit (`rename`, `delete`, ...), if one did (#241). */
  operation?: string | null;
}

/** The two texts a selection compares. */
export interface Comparison {
  oldText: string;
  newText: string;
  oldLabel: string;
  newLabel: string;
  /** The note's path on the new side (for rendering relative links). */
  path: string;
}

/** The vault-relative path of `file`, or null when it is outside the vault. */
export function relativeTo(root: string, file: string): string | null {
  const r = `${toSlashes(root).replace(/\/+$/, "")}/`;
  const f = toSlashes(file);
  return f.startsWith(r) ? f.slice(r.length) : null;
}

/** History of the open note: its commits (paged), the uncommitted state first, and the compared versions. */
@Injectable({ providedIn: "root" })
export class HistoryService {
  private readonly doc = inject(DocumentService);
  private readonly workspace = inject(WorkspaceService);
  private readonly git = inject(GitService);
  private readonly index = inject(IndexService);
  private readonly editor = inject(EditorService);

  /** The committed entries loaded so far. */
  readonly commits = signal<HistoryEntry[]>([]);
  readonly loading = signal(false);
  /** True when the log has no older entries. */
  readonly exhausted = signal(false);
  readonly error = signal<string | null>(null);
  /** Selected timeline ids (at most two, in click order); `""` stands for the uncommitted state. */
  readonly selection = signal<string[]>([]);
  readonly comparison = signal<Comparison | null>(null);
  /** Notes the latest commits deleted. */
  readonly deleted = signal<DeletedNote[]>([]);
  /** Result or failure of the last restore, for the view. */
  readonly notice = signal<string | null>(null);
  private request = 0;
  private deletedRequest = 0;
  private compareRequest = 0;

  /** Vault-relative path of the open note; null without a note in a Git vault. */
  readonly notePath = computed(() => {
    const root = this.workspace.vaultRoot();
    const file = this.doc.path();
    return root && file && this.git.available() ? relativeTo(root, file) : null;
  });

  /** Whether the open note differs from HEAD (or is new). */
  readonly uncommitted = computed(() => {
    const path = this.notePath();
    return path !== null && (this.git.status()?.changes.some((c) => c.path === path) ?? false);
  });

  /** The uncommitted state first, then the commits. */
  readonly timeline = computed<TimelineEntry[]>(() => {
    const path = this.notePath();
    const rows: TimelineEntry[] = this.commits().map((c) => ({ ...c }));
    if (path !== null && this.uncommitted()) {
      rows.unshift({ id: null, author: "", time: 0, message: "Uncommitted changes", path });
    }
    return rows;
  });

  constructor() {
    // A full reset only for another note; saves and status refreshes update in the background (#289).
    effect(() => {
      this.notePath();
      untracked(() => void this.reload());
    });
    effect(() => {
      this.index.revision();
      this.git.status();
      untracked(() => void this.refreshHead());
    });
    effect(() => {
      this.git.available();
      this.index.revision();
      this.git.status();
      untracked(() => void this.loadDeleted());
    });
  }

  /** Reads the notes the latest commits deleted. */
  async loadDeleted(): Promise<void> {
    const request = ++this.deletedRequest;
    if (!this.git.available()) {
      this.deleted.set([]);
      return;
    }
    try {
      const list = await backend.gitDeletedNotes(DELETED_COMMITS);
      if (request === this.deletedRequest) this.deleted.set(list);
    } catch {
      if (request === this.deletedRequest) this.deleted.set([]);
    }
  }

  /**
   * Writes the content of a commit into the open note (atomic write). The result is an ordinary
   * change in the Git status; the history is not touched.
   */
  async restore(entry: TimelineEntry): Promise<void> {
    const file = this.doc.path();
    if (entry.id === null || !file) return;
    this.notice.set(null);
    try {
      const text = await backend.gitNoteVersion(entry.path, entry.id);
      // Pending text is written first, so the editor cannot write it over the restored text.
      await this.editor.handle?.flush();
      await backend.writeTextFile(file, text);
      await this.doc.open(file, { addToHistory: false });
      await this.git.refresh();
      this.notice.set(`Restored ${this.label(entry)}`);
    } catch (err) {
      this.notice.set(`Restore failed: ${String(err)}`);
    }
  }

  /** The text of a commit, for the clipboard. */
  async versionText(entry: TimelineEntry): Promise<string> {
    return backend.gitNoteVersion(entry.path, entry.id);
  }

  /** Brings a deleted note back with its last content; refuses when a file of that name exists. */
  async restoreDeleted(note: DeletedNote): Promise<void> {
    const root = this.workspace.vaultRoot();
    if (!root) return;
    this.notice.set(null);
    try {
      const file = `${toSlashes(root).replace(/\/+$/, "")}/${note.path}`;
      const slash = file.lastIndexOf("/");
      await backend.createDir(file.slice(0, slash));
      await backend.createFile(file);
      await backend.writeTextFile(file, await backend.gitNoteVersion(note.path, note.parent));
      await this.workspace.reloadTree();
      await this.git.refresh();
      await this.doc.open(file);
      this.notice.set(`Restored ${note.path}`);
    } catch (err) {
      this.notice.set(`Restore failed: ${String(err)}`);
    }
  }

  /** Loads the first page again (the note, the vault or the repository changed). */
  async reload(): Promise<void> {
    const request = ++this.request;
    this.commits.set([]);
    this.exhausted.set(false);
    this.error.set(null);
    this.selection.set([]);
    this.comparison.set(null);
    this.loading.set(false);
    await this.load(request);
  }

  /**
   * Reads the first page again without clearing anything: the list is replaced only when it
   * differs, the selection stays, and the comparison is recomputed when it shows the uncommitted state.
   */
  async refreshHead(): Promise<void> {
    const path = this.notePath();
    if (path === null || this.loading()) return;
    const request = this.request;
    let page: HistoryEntry[];
    try {
      page = await backend.gitNoteHistory(path, 0, PAGE_SIZE);
    } catch {
      return;
    }
    if (request !== this.request || this.loading() || this.notePath() !== path) return;
    const current = this.commits();
    const changed = JSON.stringify(page) !== JSON.stringify(current.slice(0, PAGE_SIZE));
    if (changed) {
      this.commits.set([...page, ...current.slice(PAGE_SIZE)]);
      if (current.length <= PAGE_SIZE) this.exhausted.set(page.length < PAGE_SIZE);
    }
    const rows = this.timeline();
    const kept = this.selection().filter((k) => rows.some((r) => this.key(r) === k));
    const dropped = kept.length !== this.selection().length;
    if (dropped) this.selection.set(kept);
    if (dropped || (changed && kept.length > 0) || kept.includes("")) await this.compare();
  }

  /** Loads the next older page. */
  async loadMore(): Promise<void> {
    if (this.loading() || this.exhausted()) return;
    await this.load(this.request);
  }

  private async load(request: number): Promise<void> {
    const path = this.notePath();
    if (path === null) return;
    this.loading.set(true);
    try {
      const page = await backend.gitNoteHistory(path, this.commits().length, PAGE_SIZE);
      if (request !== this.request) return;
      this.commits.update((c) => [...c, ...page]);
      if (page.length < PAGE_SIZE) this.exhausted.set(true);
    } catch (err) {
      if (request !== this.request) return;
      this.error.set(String(err));
      this.exhausted.set(true);
    } finally {
      if (request === this.request) this.loading.set(false);
    }
  }

  private key(entry: TimelineEntry): string {
    return entry.id ?? "";
  }

  /** Click on a row: one selected shows its change; a second one shows the difference between the two. */
  async select(entry: TimelineEntry): Promise<void> {
    const key = this.key(entry);
    const current = this.selection();
    let next: string[];
    if (current.includes(key)) next = current.filter((k) => k !== key);
    else next = current.length >= 2 ? [current[1], key] : [...current, key];
    this.selection.set(next);
    await this.compare();
  }

  private async compare(): Promise<void> {
    const request = ++this.compareRequest;
    const rows = this.timeline();
    const chosen = this.selection()
      .map((k) => rows.find((r) => this.key(r) === k))
      .filter((r): r is TimelineEntry => r !== undefined);
    if (chosen.length === 0) {
      this.comparison.set(null);
      return;
    }
    try {
      let result: Comparison;
      if (chosen.length === 1) {
        const [entry] = chosen;
        const { revision, path } = this.parentOf(entry);
        const [oldText, newText] = await Promise.all([
          revision === undefined ? Promise.resolve("") : backend.gitNoteVersion(path, revision),
          backend.gitNoteVersion(entry.path, entry.id),
        ]);
        result = {
          oldText,
          newText,
          oldLabel: "before",
          newLabel: this.label(entry),
          path: entry.path,
        };
      } else {
        // Older side first: the timeline is newest first.
        const [newer, older] =
          rows.indexOf(chosen[0]) < rows.indexOf(chosen[1])
            ? [chosen[0], chosen[1]]
            : [chosen[1], chosen[0]];
        const [oldText, newText] = await Promise.all([
          backend.gitNoteVersion(older.path, older.id),
          backend.gitNoteVersion(newer.path, newer.id),
        ]);
        result = {
          oldText,
          newText,
          oldLabel: this.label(older),
          newLabel: this.label(newer),
          path: newer.path,
        };
      }
      if (request === this.compareRequest) this.comparison.set(result);
    } catch (err) {
      if (request !== this.compareRequest) return;
      this.comparison.set(null);
      this.error.set(String(err));
    }
  }

  /** What the change of an entry is measured against: the uncommitted state against HEAD, a commit against its parent. */
  private parentOf(entry: TimelineEntry): { revision: string | undefined; path: string } {
    if (entry.id === null) {
      const head = this.commits()[0];
      return { revision: head ? head.id : undefined, path: head ? head.path : entry.path };
    }
    const commit = this.commits().find((c) => c.id === entry.id);
    return { revision: commit?.parent ?? undefined, path: commit?.parentPath ?? entry.path };
  }

  private label(entry: TimelineEntry): string {
    return entry.id === null ? "uncommitted" : entry.id.slice(0, 7);
  }
}

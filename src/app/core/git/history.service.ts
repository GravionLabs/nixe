import { Injectable, computed, effect, inject, signal, untracked } from "@angular/core";

import type { DeletedNote, HistoryEntry } from "../file/backend";
import { backend } from "../file/backend";
import type { CompareInput } from "../compare/compare";
import { CompareService } from "../compare/compare.service";
import { EditorService } from "../editor/editor.service";
import { DocumentService } from "../file/document.service";
import { IndexService } from "../index/index.service";
import { toSlashes } from "../markdown/paths";
import { VaultUndoService } from "../workspace/vault-undo.service";
import { WorkspaceService } from "../workspace/workspace.service";
import { noteLabel } from "../../shared/panel/note-label";
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

/** The vault-relative path of `file`, or null when it is outside the vault. */
export function relativeTo(root: string, file: string): string | null {
  const r = `${toSlashes(root).replace(/\/+$/, "")}/`;
  const f = toSlashes(file);
  return f.startsWith(r) ? f.slice(r.length) : null;
}

/** History of the open note: its commits (paged) and the uncommitted state first; versions are compared in the main area (#324). */
@Injectable({ providedIn: "root" })
export class HistoryService {
  private readonly doc = inject(DocumentService);
  private readonly workspace = inject(WorkspaceService);
  private readonly git = inject(GitService);
  private readonly index = inject(IndexService);
  private readonly editor = inject(EditorService);
  private readonly compareView = inject(CompareService);
  private readonly undo = inject(VaultUndoService);

  /** The committed entries loaded so far. */
  readonly commits = signal<HistoryEntry[]>([]);
  readonly loading = signal(false);
  /** True when the log has no older entries. */
  readonly exhausted = signal(false);
  readonly error = signal<string | null>(null);
  /** Notes the latest commits deleted. */
  readonly deleted = signal<DeletedNote[]>([]);
  /** Result or failure of the last restore, for the view. */
  readonly notice = signal<string | null>(null);
  private request = 0;
  private deletedRequest = 0;

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
   * Puts the content of a commit into the open note as one operation commit; the current state is
   * committed first, so it stays in the history. The toast offers Undo (`undo_vault_operation`).
   * Returns whether the note was restored.
   */
  async restore(entry: TimelineEntry): Promise<boolean> {
    const file = this.doc.path();
    const path = this.notePath();
    if (entry.id === null || !file || path === null) return false;
    this.notice.set(null);
    try {
      // Pending text is written first, so the checkpoint holds it and the editor cannot write it over the restored text.
      await this.editor.handle?.flush();
      const op = await backend.gitRestoreNote(path, entry.path, entry.id, this.undo.author());
      await this.doc.open(file, { addToHistory: false });
      await this.git.refresh();
      this.undo.notice.set({ text: op.message, undo: true, error: false });
      return true;
    } catch (err) {
      this.notice.set(`Restore failed: ${String(err)}`);
      return false;
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
    this.loading.set(false);
    await this.load(request);
  }

  /** Reads the first page again without clearing anything: the list is replaced only when it differs. */
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

  /** A click on a version: this version against the one before it, in the main area. */
  async open(entry: TimelineEntry): Promise<void> {
    const { revision, path } = this.parentOf(entry);
    await this.show(async () => {
      const [oldText, newText] = await Promise.all([
        revision === undefined ? Promise.resolve("") : backend.gitNoteVersion(path, revision),
        backend.gitNoteVersion(entry.path, entry.id),
      ]);
      return { oldText, newText, oldLabel: "before", newLabel: this.label(entry) };
    });
  }

  /** The version against the current state of the note. */
  async compareWithCurrent(entry: TimelineEntry): Promise<void> {
    await this.show(async () => {
      const [oldText, newText] = await Promise.all([
        backend.gitNoteVersion(entry.path, entry.id),
        backend.gitNoteVersion(this.notePath() ?? entry.path, null),
      ]);
      return { oldText, newText, oldLabel: this.label(entry), newLabel: "current" };
    });
  }

  /** Two versions of the timeline, the older one on the old side. */
  async compareBetween(a: TimelineEntry, b: TimelineEntry): Promise<void> {
    const rows = this.timeline();
    const [newer, older] = rows.indexOf(a) < rows.indexOf(b) ? [a, b] : [b, a];
    await this.show(async () => {
      const [oldText, newText] = await Promise.all([
        backend.gitNoteVersion(older.path, older.id),
        backend.gitNoteVersion(newer.path, newer.id),
      ]);
      return { oldText, newText, oldLabel: this.label(older), newLabel: this.label(newer) };
    });
  }

  /** Shows what a restore brings (current against the version) with a Restore button. */
  async reviewRestore(entry: TimelineEntry): Promise<void> {
    if (entry.id === null) return;
    await this.show(async () => {
      const [oldText, newText] = await Promise.all([
        backend.gitNoteVersion(this.notePath() ?? entry.path, null),
        backend.gitNoteVersion(entry.path, entry.id),
      ]);
      return {
        oldText,
        newText,
        oldLabel: "current",
        newLabel: this.label(entry),
        action: {
          label: "Restore",
          note: "The current version stays in the history",
          run: () => this.restore(entry),
        },
      };
    });
  }

  private async show(
    texts: () => Promise<
      Pick<CompareInput, "oldText" | "newText" | "oldLabel" | "newLabel" | "action">
    >,
  ): Promise<void> {
    const path = this.notePath();
    if (path === null) return;
    try {
      const input = await texts();
      this.compareView.open({ path, title: noteLabel(path).title, ...input });
    } catch (err) {
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

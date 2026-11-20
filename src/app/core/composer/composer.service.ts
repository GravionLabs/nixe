import { Injectable, computed, inject, signal } from "@angular/core";
import { ask } from "@tauri-apps/plugin-dialog";

import { EditorService } from "../editor/editor.service";
import { ComposeChange, ExtractWhat, backend } from "../file/backend";
import { DocumentService } from "../file/document.service";
import { basename, joinPath } from "../markdown/paths";
import { SettingsService } from "../settings/settings.service";
import { fuzzyScore } from "../switcher/fuzzy";
import { WorkspaceService } from "../workspace/workspace.service";
import { describeChanges, headingLineAt, headingTextAt, targetNotePath } from "./composer-core";

type Job = { kind: "extract"; what: ExtractWhat } | { kind: "merge" };

export interface TargetOption {
  /** Vault-relative path. */
  path: string;
  /** True for a note that does not exist yet. */
  create: boolean;
}

const MAX_OPTIONS = 30;

/**
 * The note composer (#113): `Extract selection`, `Extract heading` and `Merge into…`. Each asks
 * for the target note, lists the notes that change, and runs as one batch in the backend.
 */
@Injectable({ providedIn: "root" })
export class ComposerService {
  private readonly workspace = inject(WorkspaceService);
  private readonly doc = inject(DocumentService);
  private readonly editor = inject(EditorService);
  private readonly settings = inject(SettingsService);

  readonly visible = signal(false);
  readonly query = signal("");
  readonly selected = signal(0);
  readonly title = signal("");
  private job: Job | null = null;

  /** The notes that match the query; a typed name that matches no note is offered as a new one (extract only). */
  readonly options = computed<TargetOption[]>(() => {
    const files = (this.workspace.vaultFiles() ?? []).filter((p) => /\.md$/iu.test(p));
    const source = this.relative(this.doc.path());
    const q = this.query().trim();
    const notes = files
      .filter((p) => p !== source)
      .map((path) => ({ path, score: q ? fuzzyScore(q, path.replace(/\.md$/iu, "")) : 0 }))
      .filter((m): m is { path: string; score: number } => m.score !== null)
      .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
      .slice(0, MAX_OPTIONS)
      .map((m): TargetOption => ({ path: m.path, create: false }));
    const typed = this.job?.kind === "extract" && q ? targetNotePath(q, "") : null;
    if (typed && typed !== source && !files.some((p) => p.toLowerCase() === typed.toLowerCase())) {
      notes.push({ path: typed, create: true });
    }
    return notes;
  });

  /** Moves the selection of the editor into a note. */
  async extractSelection(): Promise<void> {
    const selection = this.editor.handle?.selection?.();
    if (!this.editor.handle || !this.doc.path()) throw new Error("Open the note in the editor to extract text.");
    if (!selection) throw new Error("Select the text to extract first.");
    await this.editor.handle.flush();
    this.start({ kind: "extract", what: { kind: "selection", start: selection.start, end: selection.end, expected: selection.text } }, "Extract selection to…", "");
  }

  /** Moves the heading at the cursor, with everything below it, into a note. */
  async extractHeading(): Promise<void> {
    const path = this.doc.path();
    if (!this.editor.handle || !path) throw new Error("Open the note in the editor to extract a heading.");
    await this.editor.handle.flush();
    const text = await backend.readTextFile(path);
    const line = this.editor.handle.headingLine?.() ?? null;
    const at = line ?? headingLineAt(text, 1);
    if (at === null) throw new Error("The cursor is not below a heading.");
    this.start({ kind: "extract", what: { kind: "heading", line: at } }, "Extract heading to…", headingTextAt(text, at));
  }

  /** Appends the open note to another one and moves it to `.trash/`. */
  async mergeInto(): Promise<void> {
    if (!this.doc.path()) throw new Error("Open the note to merge.");
    await this.editor.handle?.flush();
    this.start({ kind: "merge" }, "Merge into…", "");
  }

  close(): void {
    this.visible.set(false);
    this.job = null;
  }

  setQuery(query: string): void {
    this.query.set(query);
    this.selected.set(0);
  }

  move(delta: number): void {
    const n = this.options().length;
    if (n) this.selected.update((i) => (i + delta + n) % n);
  }

  current(): TargetOption | null {
    return this.options()[this.selected()] ?? null;
  }

  /**
   * Runs the job against `option`: shows the notes that change, asks, applies. Returns false when
   * the user declines.
   */
  async choose(option: TargetOption): Promise<boolean> {
    const job = this.job;
    const root = this.workspace.vaultRoot();
    const source = this.doc.path();
    if (!job || !root || !source) return false;
    this.close();
    const target = joinPath(root, option.path);
    const embed = this.settings.extractEmbed();
    const preview: ComposeChange[] =
      job.kind === "merge" ? await backend.mergePreview(source, target) : await backend.extractPreview(source, target, job.what, embed);
    const title = job.kind === "merge" ? `Merge into ${basename(option.path)}` : `Extract to ${basename(option.path)}`;
    if (!(await ask(`These notes change:\n\n${describeChanges(preview)}`, { title, okLabel: job.kind === "merge" ? "Merge" : "Extract" }))) {
      return false;
    }
    await this.editor.handle?.flush();
    if (job.kind === "merge") {
      await backend.mergeNote(source, target);
      this.editor.editing.set(false);
      await this.workspace.reloadTree();
      await this.doc.open(target, { addToHistory: false });
    } else {
      await backend.extractText(source, target, job.what, embed);
      await this.workspace.reloadTree();
      await this.doc.reload();
    }
    return true;
  }

  private start(job: Job, title: string, query: string): void {
    this.job = job;
    this.title.set(title);
    this.query.set(query);
    this.selected.set(0);
    this.visible.set(true);
  }

  private relative(path: string | null): string | null {
    const root = this.workspace.vaultRoot();
    return path && root && path.startsWith(root + "/") ? path.slice(root.length + 1) : null;
  }
}

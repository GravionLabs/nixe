import { Injectable, computed, inject, signal } from "@angular/core";
import { ask } from "@tauri-apps/plugin-dialog";

import { EditorService } from "../editor/editor.service";
import type {
  NoteReplacements,
  ReplaceApplied,
  ReplaceExclusions,
  ReplaceOptions,
} from "../file/backend";
import { backend } from "../file/backend";
import { DocumentService } from "../file/document.service";
import { SettingsService } from "../settings/settings.service";
import { WorkspaceService } from "../workspace/workspace.service";

/** Key of one match in the exclusion set. */
export const matchKey = (path: string, index: number): string => `${path}\u0000${index}`;

/** What the confirmation says: the number of notes and replacements. */
export function describeReplace(notes: number, replacements: number): string {
  const n = `${notes} note${notes === 1 ? "" : "s"}`;
  const r = `${replacements} replacement${replacements === 1 ? "" : "s"}`;
  return `Replace ${r} in ${n}?\n\nThe notes are rewritten; with Git, the open changes are committed first, so the replacement can be undone as a whole. Nothing in .obsidian/, .git/ or .trash/ is touched.`;
}

/**
 * Find and replace across the vault (#115). The search field holds the text to find; the preview
 * lists every replacement as a diff; notes and single matches can be left out; one batch applies.
 */
@Injectable({ providedIn: "root" })
export class ReplaceService {
  private readonly workspace = inject(WorkspaceService);
  private readonly doc = inject(DocumentService);
  private readonly editor = inject(EditorService);
  private readonly settings = inject(SettingsService);

  /** The replace field is shown. */
  readonly enabled = signal(false);
  readonly replacement = signal("");
  readonly regex = signal(false);
  readonly caseSensitive = signal(false);
  readonly wholeWord = signal(false);
  readonly notes = signal<NoteReplacements[]>([]);
  readonly error = signal<string | null>(null);
  readonly busy = signal(false);
  private readonly excludedNotes = signal<ReadonlySet<string>>(new Set());
  private readonly excludedMatches = signal<ReadonlySet<string>>(new Set());
  private request = 0;

  /** Notes and matches that the batch would change, after the exclusions. */
  readonly totals = computed(() => {
    let notes = 0;
    let replacements = 0;
    for (const note of this.notes()) {
      if (this.excludedNotes().has(note.path)) continue;
      const left =
        note.count -
        note.replacements.filter((r) => this.excludedMatches().has(matchKey(note.path, r.index)))
          .length;
      if (left > 0) {
        notes++;
        replacements += left;
      }
    }
    return { notes, replacements };
  });

  isNoteExcluded(path: string): boolean {
    return this.excludedNotes().has(path);
  }

  isMatchExcluded(path: string, index: number): boolean {
    return this.excludedMatches().has(matchKey(path, index));
  }

  toggleNote(path: string): void {
    this.excludedNotes.update((s) => toggled(s, path));
  }

  toggleMatch(path: string, index: number): void {
    this.excludedMatches.update((s) => toggled(s, matchKey(path, index)));
  }

  toggle(): void {
    this.enabled.update((v) => !v);
    if (!this.enabled()) this.clear();
  }

  clear(): void {
    this.request++;
    this.notes.set([]);
    this.error.set(null);
    this.excludedNotes.set(new Set());
    this.excludedMatches.set(new Set());
  }

  private options(find: string): ReplaceOptions {
    return {
      find,
      replace: this.replacement(),
      regex: this.regex(),
      caseSensitive: this.caseSensitive(),
      wholeWord: this.wholeWord(),
    };
  }

  /** Reads the preview for `find`; the newest request wins. A changed preview resets the exclusions. */
  async refresh(find: string): Promise<void> {
    const request = ++this.request;
    if (!this.enabled() || !find) {
      this.notes.set([]);
      this.error.set(null);
      return;
    }
    try {
      const notes = await backend.replacePreview(this.options(find));
      if (request !== this.request) return;
      this.excludedNotes.set(new Set());
      this.excludedMatches.set(new Set());
      this.notes.set(notes);
      this.error.set(null);
    } catch (err) {
      if (request !== this.request) return;
      this.notes.set([]);
      this.error.set(String(err));
    }
  }

  /** Asks, then replaces. Returns the result, or null when the user declined or nothing is left to do. */
  async apply(find: string): Promise<ReplaceApplied | null> {
    const { notes, replacements } = this.totals();
    if (!find || notes === 0) return null;
    if (
      !(await ask(describeReplace(notes, replacements), {
        title: "Replace in the vault",
        okLabel: "Replace",
      }))
    )
      return null;
    this.busy.set(true);
    try {
      await this.editor.handle?.flush();
      const exclusions: ReplaceExclusions = {
        notes: [...this.excludedNotes()],
        matches: [...this.excludedMatches()].map((k): [string, number] => {
          const [path, index] = k.split("\u0000");
          return [path, Number(index)];
        }),
      };
      const done = await backend.replaceApply(
        this.options(find),
        exclusions,
        this.settings.gitAuthorName().trim() || null,
        this.settings.gitAuthorEmail().trim() || null,
      );
      await this.workspace.reloadTree();
      if (this.doc.path()) await this.doc.reload();
      await this.refresh(find);
      return done;
    } finally {
      this.busy.set(false);
    }
  }
}

function toggled(set: ReadonlySet<string>, key: string): Set<string> {
  const next = new Set(set);
  if (!next.delete(key)) next.add(key);
  return next;
}

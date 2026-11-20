import { Injectable, computed, inject, signal } from "@angular/core";

import { EditorService } from "../editor/editor.service";
import { backend } from "../file/backend";
import { DocumentService } from "../file/document.service";
import { basename, joinPath } from "../markdown/paths";
import { SettingsService } from "../settings/settings.service";
import { fuzzyScore } from "../switcher/fuzzy";
import { WorkspaceService } from "../workspace/workspace.service";
import { expandTemplate } from "./template-core";

export interface TemplateEntry {
  /** Vault-relative path. */
  path: string;
  /** File name without extension. */
  name: string;
}

function trimSlashes(folder: string): string {
  return folder.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
}

/** The templates of the vault's template folder, listed by the `Insert template` command. */
@Injectable({ providedIn: "root" })
export class TemplateService {
  private readonly workspace = inject(WorkspaceService);
  private readonly doc = inject(DocumentService);
  private readonly editor = inject(EditorService);
  private readonly settings = inject(SettingsService);

  readonly visible = signal(false);
  readonly query = signal("");
  readonly selected = signal(0);
  private readonly entries = signal<TemplateEntry[]>([]);

  readonly matches = computed<TemplateEntry[]>(() => {
    const q = this.query().trim();
    const all = this.entries();
    if (!q) return all;
    return all
      .map((entry) => ({ entry, score: fuzzyScore(q, entry.name) }))
      .filter((m): m is { entry: TemplateEntry; score: number } => m.score !== null)
      .sort((a, b) => b.score - a.score || a.entry.name.localeCompare(b.entry.name))
      .map((m) => m.entry);
  });

  /** The template folder: `.obsidian/templates.json` first, then the setting; null when neither names one. */
  async folder(): Promise<string | null> {
    const fromVault = await backend.templateFolder().catch(() => null);
    return trimSlashes(fromVault ?? "") || trimSlashes(this.settings.templateFolder()) || null;
  }

  /** The Markdown files in the template folder (and below it), by name. */
  async list(): Promise<TemplateEntry[]> {
    const folder = await this.folder();
    if (!folder) throw new Error("No template folder: set `folder` in .obsidian/templates.json.");
    const prefix = `${folder}/`;
    const entries = (this.workspace.vaultFiles() ?? [])
      .filter((p) => p.startsWith(prefix) && /\.md$/iu.test(p))
      .map((path) => ({ path, name: basename(path).replace(/\.md$/iu, "") }))
      .sort((a, b) => a.name.localeCompare(b.name));
    if (!entries.length) throw new Error(`No templates in ${folder}.`);
    return entries;
  }

  async open(): Promise<void> {
    if (!this.editor.handle) throw new Error("Open the editor to insert a template.");
    this.entries.set(await this.list());
    this.query.set("");
    this.selected.set(0);
    this.visible.set(true);
  }

  close(): void {
    this.visible.set(false);
  }

  setQuery(query: string): void {
    this.query.set(query);
    this.selected.set(0);
  }

  /** Moves the selection, wrapping around. */
  move(delta: number): void {
    const n = this.matches().length;
    if (n) this.selected.update((i) => (i + delta + n) % n);
  }

  current(): TemplateEntry | null {
    return this.matches()[this.selected()] ?? null;
  }

  /** Inserts a template into the note in the editor. */
  async insert(entry: TemplateEntry): Promise<void> {
    this.close();
    const root = this.workspace.vaultRoot();
    const handle = this.editor.handle;
    if (!root || !handle) throw new Error("Open the editor to insert a template.");
    const text = await backend.readTextFile(joinPath(root, entry.path));
    const title = basename(this.doc.path() ?? "").replace(/\.[^.]*$/, "");
    handle.insertTemplate(expandTemplate(text, { title, now: new Date() }));
  }
}

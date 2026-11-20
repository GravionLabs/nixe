import { Injectable, computed, inject, signal } from "@angular/core";

import { DocumentService } from "../file/document.service";
import { EditorService } from "../editor/editor.service";
import type { TagCount } from "../file/backend";
import { backend } from "../file/backend";
import { SearchService } from "../index/search.service";
import { joinPath } from "../markdown/paths";
import type { OutlineHeading } from "../outline/outline-core";
import { OutlineService } from "../outline/outline.service";
import { ShellService } from "../shell/shell.service";
import type { SwitcherMatch } from "../switcher/fuzzy";
import { fuzzyMatch } from "../switcher/fuzzy";
import { SwitcherService } from "../switcher/switcher.service";
import { TabsService } from "../tabs/tabs.service";
import type { TemplateEntry } from "../templates/template.service";
import { TemplateService } from "../templates/template.service";
import { RecentPickerService } from "../workspace/recent-picker.service";
import { VaultOpsService } from "../workspace/vault-ops.service";
import { WorkspaceService } from "../workspace/workspace.service";
import type { Command } from "./command-registry";
import { CommandRegistry } from "./command-registry";

/** What the input searches: notes without a prefix, the others after their prefix character. */
export type PaletteMode = "notes" | "commands" | "headings" | "tags" | "templates" | "vaults";

/** The prefix character of each mode; notes have none. */
export const MODE_PREFIX: Readonly<Record<Exclude<PaletteMode, "notes">, string>> = {
  commands: ">",
  headings: "@",
  tags: "#",
  templates: "/",
  vaults: "~",
};

/** The prefixes shown as hints in the empty input. */
export const PREFIX_HINTS: readonly { prefix: string; label: string }[] = [
  { prefix: ">", label: "commands" },
  { prefix: "@", label: "headings" },
  { prefix: "#", label: "tags" },
  { prefix: "/", label: "templates" },
];

/** The mode and the search text of what is typed: the first character picks the mode. */
export function parseQuery(raw: string): { mode: PaletteMode; text: string } {
  for (const [mode, prefix] of Object.entries(MODE_PREFIX)) {
    if (raw.startsWith(prefix)) return { mode: mode as PaletteMode, text: raw.slice(1).trim() };
  }
  return { mode: "notes", text: raw };
}

export type PaletteItem =
  | { kind: "note"; match: SwitcherMatch }
  | { kind: "command"; command: Command }
  | { kind: "heading"; heading: OutlineHeading }
  | { kind: "tag"; tag: TagCount }
  | { kind: "template"; entry: TemplateEntry }
  | { kind: "vault"; path: string };

const MAX_RECENT_USED = 20;

/** Moves `recent` entries to the front in their order, then the rest as they come. */
function recentFirst<T>(items: readonly T[], key: (item: T) => string, recent: readonly string[]) {
  const rank = new Map(recent.map((k, i) => [k, i]));
  return items
    .map((item, i) => ({ item, i, r: rank.get(key(item)) ?? Infinity }))
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map((x) => x.item);
}

/** Filters by fuzzy match on `label`, best first; no text keeps the order. */
function filterBy<T>(items: readonly T[], text: string, label: (item: T) => string): T[] {
  if (!text) return [...items];
  return items
    .map((item, i) => ({ item, i, score: fuzzyMatch(text, label(item))?.score ?? null }))
    .filter((m): m is { item: T; i: number; score: number } => m.score !== null)
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .map((m) => m.item);
}

/**
 * The one overlay: quick switcher, command palette, headings, tags, templates and recent vaults.
 * The text of the input picks the mode by its first character; deleting the prefix changes the
 * mode without closing the overlay.
 */
@Injectable({ providedIn: "root" })
export class PaletteService {
  private readonly registry = inject(CommandRegistry);
  private readonly switcher = inject(SwitcherService);
  private readonly outline = inject(OutlineService);
  private readonly templates = inject(TemplateService);
  private readonly recentVaults = inject(RecentPickerService);
  private readonly workspace = inject(WorkspaceService);
  private readonly doc = inject(DocumentService);
  private readonly editor = inject(EditorService);
  private readonly tabs = inject(TabsService);
  private readonly ops = inject(VaultOpsService);
  private readonly search = inject(SearchService);
  private readonly shell = inject(ShellService);

  readonly visible = signal(false);
  /** The text of the input, prefix included. */
  readonly query = signal("");
  readonly selected = signal(0);
  /** Bumped on open so that `when` conditions are evaluated again. */
  private readonly opened = signal(0);
  private readonly tagList = signal<TagCount[]>([]);
  private readonly templateList = signal<TemplateEntry[]>([]);
  /** Why a mode has nothing to list (no template folder, no editor), shown instead of the list. */
  readonly notice = signal<string | null>(null);
  /** Ids of the commands run from the palette, newest first. */
  private readonly usedCommands = signal<string[]>([]);
  /** Paths of the templates inserted from the palette, newest first. */
  private readonly usedTemplates = signal<string[]>([]);

  readonly mode = computed(() => parseQuery(this.query()).mode);
  readonly text = computed(() => parseQuery(this.query()).text);

  private readonly noteSearch = computed(() =>
    this.mode() === "notes" ? this.switcher.search(this.text()) : { matches: [], truncated: false },
  );
  /** True when more notes match than the list shows. */
  readonly truncated = computed(() => this.noteSearch().truncated);

  readonly items = computed<PaletteItem[]>(() => {
    this.opened();
    const text = this.text();
    switch (this.mode()) {
      case "notes":
        return this.noteSearch().matches.map((match) => ({ kind: "note", match }));
      case "commands": {
        const all = this.registry.available().sort((a, b) => a.title.localeCompare(b.title));
        const list = text
          ? filterBy(all, text, (c) => c.title)
          : recentFirst(all, (c) => c.id, this.usedCommands());
        return list.map((command) => ({ kind: "command", command }));
      }
      case "headings":
        return filterBy(this.outline.headings(), text, (h) => h.text).map((heading) => ({
          kind: "heading",
          heading,
        }));
      case "tags":
        return filterBy(this.tagList(), text.replace(/^#/, ""), (t) => t.tag).map((tag) => ({
          kind: "tag",
          tag,
        }));
      case "templates": {
        const all = this.templateList();
        const list = text
          ? filterBy(all, text, (e) => e.name)
          : recentFirst(all, (e) => e.path, this.usedTemplates());
        return list.map((entry) => ({ kind: "template", entry }));
      }
      case "vaults":
        return filterBy(this.recentVaults.vaults(), text, (p) => p).map((path) => ({
          kind: "vault",
          path,
        }));
    }
  });

  /** Opens the overlay with `query` in the input: "" for notes, ">" for commands. */
  open(query = ""): void {
    this.selected.set(0);
    this.opened.update((n) => n + 1);
    this.setQuery(query);
    this.visible.set(true);
  }

  /** Opens the overlay in the templates mode; fails with the reason when none can be inserted. */
  async openTemplates(): Promise<void> {
    await this.templates.list();
    this.open(MODE_PREFIX.templates);
  }

  close(): void {
    this.visible.set(false);
  }

  setQuery(query: string): void {
    const before = this.visible() ? this.mode() : null;
    this.query.set(query);
    this.selected.set(0);
    const mode = this.mode();
    if (mode === before) return;
    this.notice.set(null);
    void this.prepare(mode);
  }

  /** Loads what a mode lists; a failure becomes the notice of the mode. */
  private async prepare(mode: PaletteMode): Promise<void> {
    try {
      switch (mode) {
        case "notes":
          await this.switcher.load();
          break;
        case "tags":
          this.tagList.set(await backend.tags());
          break;
        case "templates":
          this.templateList.set(await this.templates.list());
          break;
        case "vaults":
          await this.recentVaults.prune();
          break;
      }
    } catch (err) {
      if (this.mode() !== mode) return;
      if (mode === "templates") this.notice.set(String(err instanceof Error ? err.message : err));
      else if (mode === "tags") this.tagList.set([]);
    }
  }

  /** Moves the selection, wrapping around. */
  move(delta: number): void {
    const n = this.items().length;
    if (n) this.selected.update((i) => (i + delta + n) % n);
  }

  /** The item Enter would run; null when nothing matches. */
  current(): PaletteItem | null {
    return this.items()[this.selected()] ?? null;
  }

  /** Runs an item and closes the overlay; `newTab` opens a note in a new tab. */
  async run(item: PaletteItem, newTab = false): Promise<void> {
    switch (item.kind) {
      case "note": {
        const root = item.match.entry.rootPath ?? this.workspace.vaultRoot();
        if (!root) return;
        this.close();
        const path = joinPath(root, item.match.entry.path);
        if (newTab) await this.tabs.openInNewTab(path);
        else await this.doc.open(path);
        return;
      }
      case "command": {
        this.close();
        this.usedCommands.update((u) =>
          [item.command.id, ...u.filter((id) => id !== item.command.id)].slice(0, MAX_RECENT_USED),
        );
        this.registry.execute(item.command.id);
        return;
      }
      case "heading": {
        this.close();
        const handle = this.editor.editing() ? this.editor.handle : null;
        if (handle) handle.scrollToLine(item.heading.line);
        else this.doc.pendingLine.set(item.heading.line);
        return;
      }
      case "tag":
        this.close();
        this.shell.show("search");
        await this.search.setQuery(`tag:#${item.tag.tag.replace(/^#/, "")}`);
        return;
      case "template":
        this.close();
        this.usedTemplates.update((u) =>
          [item.entry.path, ...u.filter((p) => p !== item.entry.path)].slice(0, MAX_RECENT_USED),
        );
        await this.templates.insert(item.entry);
        return;
      case "vault":
        this.close();
        await this.recentVaults.choose(item.path);
        return;
    }
  }

  /** Notes mode with text and no match: the text becomes a new note. */
  async createNote(): Promise<void> {
    const text = this.text();
    if (this.mode() !== "notes" || !text.trim()) return;
    this.close();
    await this.ops.createNoteForLink(text);
  }
}

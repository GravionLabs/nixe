import { NgTemplateOutlet } from "@angular/common";
import {
  Component,
  DestroyRef,
  InjectionToken,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from "@angular/core";
import type { WritableSignal } from "@angular/core";
import type { HxColumn, HxLazyLoadEvent } from "@gravionlabs/helix-ui";
import { HxDataTable, HxSelectButton, HxTableBody } from "@gravionlabs/helix-ui";
import { convertFileSrc } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";

import type {
  BaseCell,
  BaseCover,
  BaseGroup,
  BaseLink,
  BaseResult,
  BaseView,
} from "../../core/file/backend";
import { backend } from "../../core/file/backend";
import { NoteEditService } from "../../core/file/note-edit.service";
import { IndexService } from "../../core/index/index.service";
import { basename, isBasePath, isMarkdownPath, joinPath } from "../../core/markdown/paths";
import type { PropertyChange } from "../../core/markdown/property-change";
import { parseWikilinkTarget, resolveWikilink } from "../../core/markdown/wikilink-resolver";
import { SettingsService } from "../../core/settings/settings.service";
import type { BaseChoice } from "../../core/tabs/tabs.service";
import { CURRENT_TAB, TabsService } from "../../core/tabs/tabs.service";
import { WorkspaceService } from "../../core/workspace/workspace.service";
import { BaseCellComponent } from "./base-cell.component";
import { cellEditor, cellOfValue, type CellEditor } from "./cell-edit";
import { cellText } from "./cell-text";

/** The column whose cells open the note. */
const FILE_NAME = "file.name";

interface ViewCell {
  text: string;
  /** Set for a checkbox property: the cell shows a box instead of the text. */
  checked: boolean | null;
  /** The note a click opens, relative to the vault. */
  note: string | null;
  /** The address a click opens outside the app. */
  url: string | null;
  /** The cell could not be evaluated; the text says why. */
  failed: boolean;
  /** Set for a cell of a note property that can be edited in the table. */
  edit: CellEdit | null;
}

interface CellEdit {
  editor: CellEditor;
  property: string;
  label: string;
  value: unknown;
}

/** A value that was edited in the table and that the shown result does not hold yet. */
interface Edited {
  value: unknown;
  /** The writes that are under way. */
  pending: number;
}

const editKey = (path: string, property: string): string => `${path}\n${property}`;

/** What the cover box of a card shows; both are null for the placeholder. */
interface ViewCover {
  image: string | null;
  color: string | null;
}

/** A row of the table or a card: a note, or the heading of a group. */
interface ViewRow {
  key: string;
  /** Set for the heading of a group. */
  group: { label: string; value: string; count: number } | null;
  cells: ViewCell[];
  /** The note of the row, relative to the vault; empty for a heading. */
  path: string;
  /** The name of the note, the title of its card. */
  title: string;
  /** The values a card lists: every column but the name of the note, which is its title. */
  properties: { label: string; cell: ViewCell }[];
  cover: BaseCover | null;
}

/** A base shown in a note: a ```base block, or an embed of a `.base` file. */
export type BaseBlock = (
  | {
      /** The YAML of the base. */
      source: string;
    }
  | {
      /** The target of the embed: `File.base` or `File.base#View name`. */
      embed: string;
    }
) & {
  /** The note that embeds the base, as an absolute path: `this` in its expressions. */
  note: string | null;
  /** The view and sort chosen in the block. */
  choice: WritableSignal<BaseChoice>;
};

/** Provided to a `BaseComponent` that shows a base in a note instead of the file of its tab. */
export const BASE_BLOCK = new InjectionToken<BaseBlock>("BASE_BLOCK");

/**
 * A base: the tab of a `.base` file, a ```base block of a note or an embed of a `.base` file in one.
 * The core answers its view from the index.
 */
@Component({
  selector: "app-base",
  imports: [BaseCellComponent, HxDataTable, HxSelectButton, HxTableBody, NgTemplateOutlet],
  templateUrl: "./base.component.html",
  styleUrl: "./base.component.css",
  host: { "[class.embedded]": "!!block" },
})
export class BaseComponent {
  /** Null in the tab of a `.base` file. */
  protected readonly block = inject(BASE_BLOCK, { optional: true });
  private readonly tab = this.block ? null : inject(CURRENT_TAB);
  /** The file `this` refers to: the note of the block, else the base file. */
  private readonly file = computed(() => (this.tab ? this.tab.base() : this.block!.note));
  private readonly choice = this.tab ? this.tab.baseChoice : this.block!.choice;
  private readonly index = inject(IndexService);
  private readonly notes = inject(NoteEditService);
  private readonly settings = inject(SettingsService);
  private readonly tabs = inject(TabsService);
  private readonly workspace = inject(WorkspaceService);

  /** The file and view an embed names; null for a tab and a ```base block. */
  private readonly embed =
    this.block && "embed" in this.block ? parseWikilinkTarget(this.block.embed) : null;
  /** The view an embed names, also one that starts with `^`. */
  private readonly embedView =
    this.embed?.heading ?? (this.embed?.block ? `^${this.embed.block}` : null);
  /**
   * The `.base` file of an embed, relative to the vault, resolved like a link. Null when there is
   * none, undefined while the files of the vault are not listed yet.
   */
  private readonly embedded = computed(() => {
    if (!this.embed) return undefined;
    const files = this.workspace.vaultFiles();
    if (!files) return undefined;
    return resolveWikilink(this.embed.note, files.filter(isBasePath));
  });

  protected readonly name = computed(() => {
    if (!this.block) return basename(this.file() ?? "");
    return this.embed ? basename(this.embed.note) : "Base";
  });
  /** The last answered table; null while loading and after a failure. */
  protected readonly result = signal<BaseResult | null>(null);
  protected readonly error = signal<string | null>(null);

  /** All views of the file, also while the shown one cannot be read. */
  protected readonly views = signal<BaseView[]>([]);
  /** The index of the shown view in `views`. */
  protected readonly active = signal<number | null>(null);
  protected readonly viewOptions = computed(() =>
    this.views().map((view, index) => ({ index, label: view.name ?? `View ${index + 1}` })),
  );

  protected readonly columns = computed<HxColumn[]>(() =>
    (this.result()?.columns ?? []).map((c, i) => ({
      field: `c${i}`,
      header: c.label,
      sortable: true,
    })),
  );
  /** The column the tab is sorted by after a click on its header. */
  protected readonly sortField = computed(() => {
    const sort = this.choice().sort;
    const column = this.result()?.columns.findIndex((c) => c.id === sort?.property) ?? -1;
    return column < 0 ? null : `c${column}`;
  });
  protected readonly sortOrder = computed(() =>
    this.choice().sort?.direction === "DESC" ? -1 : 1,
  );
  /** The addresses of the cover images that could not be loaded in the shown result. */
  private readonly failed = signal<ReadonlySet<string>>(new Set());
  /** By `editKey`. */
  private readonly edited = signal<ReadonlyMap<string, Edited>>(new Map());
  protected readonly rows = computed<ViewRow[]>(() => {
    const result = this.result();
    if (!result) return [];
    const edited = this.edited();
    const columnCells = result.columns.map((column, i) =>
      column.property ? result.rows.flatMap((row) => row.cells[i] ?? []) : [],
    );
    const rows: ViewRow[] = result.rows.map((row) => {
      const title = basename(row.path).replace(/\.[^.]*$/, "");
      const cells = row.cells.map((cell, i) => {
        const column = result.columns[i];
        const property = column?.property;
        const change = property ? edited.get(editKey(row.path, property)) : undefined;
        const shown = change ? cellOfValue(change.value) : cell;
        const view = viewCell(shown, column?.id === FILE_NAME ? row.path : null);
        if (!column || !property) return view;
        // A block of a note shows the values; they are edited in the base tab or the note.
        const editor = this.block ? null : cellEditor(property, shown, columnCells[i] ?? []);
        if (editor) {
          const label = `${column.label} of ${title}`;
          view.edit = { editor, property, label, value: shown.value };
        }
        return view;
      });
      return {
        key: `note ${row.path}`,
        group: null,
        cells,
        path: row.path,
        title,
        properties: result.columns.flatMap((column, i) => {
          const cell = cells[i];
          return cell && column.id !== FILE_NAME ? [{ label: column.label, cell }] : [];
        }),
        cover: row.cover,
      };
    });
    const grouping = result.grouping;
    if (!grouping) return rows;
    let start = 0;
    return grouping.groups.flatMap((group, i) => [
      groupRow(grouping.label, group, i),
      ...rows.slice(start, (start += group.rows)),
    ]);
  });

  /**
   * Changes whenever the table must be read again: another file or vault, index updates (vault
   * changes).
   */
  private readonly key = computed(() =>
    [
      this.file(),
      this.embedded(),
      JSON.stringify(this.choice()),
      this.workspace.vaultRoot(),
      this.index.status().state,
      this.index.revision(),
    ].join("\n"),
  );
  /** Counts the queries: only the answer of the newest one is shown. */
  private request = 0;
  private shown: string | null = null;

  constructor() {
    // An answer that arrives after the component is gone is dropped.
    inject(DestroyRef).onDestroy(() => this.request++);
    effect(() => {
      this.key();
      untracked(() => void this.refresh());
    });
  }

  private async refresh(): Promise<void> {
    const request = ++this.request;
    const path = this.file();
    const embedded = this.embedded();
    // The table of another file is not shown while this one is read.
    const shown = `${path}\n${embedded}`;
    if (shown !== this.shown) {
      this.result.set(null);
      this.error.set(null);
      this.edited.set(new Map());
      this.views.set([]);
      this.active.set(null);
      this.shown = shown;
    }
    // A tab without a base has nothing to show; a block of an unsaved note is outside the vault.
    if (path === null && !this.block) return;
    // Only the notes of the vault are indexed here: a base of another root would list the wrong ones.
    const root = this.workspace.vaultRoot();
    const prefix = root === null ? null : `${root.replace(/\/$/, "")}/`;
    if (path === null || prefix === null || !path.startsWith(prefix)) {
      this.result.set(null);
      this.error.set("Bases outside the open vault are not supported yet.");
      return;
    }
    const state = this.index.status().state;
    if (state !== "ready") {
      this.result.set(null);
      this.error.set(state === "error" ? "The vault index is not available." : null);
      return;
    }
    if (this.embed && !embedded) {
      if (embedded === null) this.missing(`Base not found: ${this.embed.note}`);
      return;
    }
    try {
      const source =
        this.block && "source" in this.block
          ? this.block.source
          : await backend.readTextFile(embedded ? joinPath(root!, embedded) : path);
      if (request !== this.request) return;
      const views = await backend.baseViews(source);
      if (request !== this.request) return;
      let { view, sort } = this.choice();
      const named = view ? null : this.embedView;
      const index = named === null ? shownView(views, view) : namedView(views, named);
      // The chosen view is gone: its sort does not apply to the one shown instead.
      // Unnamed views can only be told apart by their place.
      const moved = view?.name === null && index !== view.index;
      if (view && (index === null || views[index]?.name !== view.name || moved)) {
        this.choice.set({ view: null, sort: null });
        sort = null;
      }
      this.views.set(views);
      this.active.set(index);
      if (named !== null && index === null) {
        this.result.set(null);
        this.error.set(`View not found: ${named} in ${embedded}`);
        return;
      }
      const result = await backend.baseQuery(source, index, sort, path.slice(prefix.length));
      if (request !== this.request) return;
      // An image that was missing may be there now.
      this.failed.set(new Set());
      this.result.set(result);
      // The result holds the stored values; those still being written stay as edited.
      this.edited.update((edited) => new Map([...edited].filter(([, e]) => e.pending > 0)));
      this.error.set(null);
    } catch (err) {
      // The command log has the failure already (`loggedInvoke`).
      if (request !== this.request) return;
      this.result.set(null);
      this.error.set(String(err));
    }
  }

  /** Shows why there is no base, without the views of the one shown before. */
  private missing(message: string): void {
    this.views.set([]);
    this.active.set(null);
    this.result.set(null);
    this.error.set(message);
  }

  /**
   * Writes an edited cell into its note. The new value shows at once; when it cannot be stored,
   * the old one comes back with the reason.
   */
  protected async edit(path: string, cell: CellEdit, change: PropertyChange): Promise<void> {
    const root = this.workspace.vaultRoot();
    if (!root) return;
    const key = editKey(path, cell.property);
    const before = this.edited().get(key);
    this.setEdited(key, { value: change(cell.value), pending: (before?.pending ?? 0) + 1 });
    try {
      const value = await this.notes.editProperty(joinPath(root, path), cell.property, change);
      const now = this.edited().get(key);
      if (!now) return;
      // A later edit of the cell is still being written: its value stays.
      const pending = now.pending - 1;
      this.setEdited(key, { value: pending ? now.value : value, pending });
    } catch (err) {
      const now = this.edited().get(key);
      if (now && now.pending > 1) this.setEdited(key, { ...now, pending: now.pending - 1 });
      else this.setEdited(key, before && !before.pending ? before : null);
      const reason = err instanceof Error ? err.message : String(err);
      const message = `${cell.label} was not changed: ${reason}`;
      console.error(message);
      // The tab may be another one by now: the notice goes to the app.
      this.tabs.notice.set(message);
    }
  }

  private setEdited(key: string, value: Edited | null): void {
    this.edited.update((edited) => {
      const next = new Map(edited);
      if (value) next.set(key, value);
      else next.delete(key);
      return next;
    });
  }

  /** The cover of a card; an image of the vault loads like one in a note. */
  protected coverOf(cover: BaseCover | null): ViewCover {
    const root = this.workspace.vaultRoot();
    if (cover?.type === "color") return { image: null, color: cover.value };
    let image: string | null = null;
    if (cover?.type === "url") image = cover.value;
    else if (cover && root) image = convertFileSrc(joinPath(root, cover.value));
    return { image: image && !this.failed().has(image) ? image : null, color: null };
  }

  /** A cover image that cannot be loaded leaves the placeholder. */
  protected coverFailed(image: string): void {
    this.failed.update((failed) => new Set(failed).add(image));
  }

  /** Shows another view in this tab, with its own sort. */
  protected show(index: number): void {
    const view = this.views()[index];
    if (!view || index === this.active()) return;
    // The table of the view before is not shown while this one is read.
    this.result.set(null);
    this.error.set(null);
    this.active.set(index);
    this.choice.set({ view: { index, name: view.name }, sort: null });
  }

  /** A click on a column header: ascending, descending, then the sort of the view again. */
  protected sortBy({ sortField, sortOrder }: HxLazyLoadEvent): void {
    const column = this.columns().findIndex((c) => c.field === sortField);
    const property = this.result()?.columns[column]?.id;
    this.choice.update((choice) => ({
      ...choice,
      sort: property ? { property, direction: sortOrder === -1 ? "DESC" : "ASC" } : null,
    }));
  }

  /** Opens a web, mail or phone address of a link outside the app. */
  protected async openExternal(url: string): Promise<void> {
    try {
      await openUrl(url);
    } catch (err) {
      this.tabs.notice.set(String(err));
    }
  }

  /** Opens the note of a row or of a link beside the table, which stays. */
  protected async open(rel: string): Promise<void> {
    const root = this.workspace.vaultRoot();
    if (!root) return;
    const path = joinPath(root, rel);
    try {
      if (this.settings.previewTabs()) await this.tabs.openPreview(path);
      else await this.tabs.openInNewTab(path);
    } catch (err) {
      // Opening switches the tab, so this component may be gone: the notice goes to the app.
      this.tabs.notice.set(String(err));
    }
  }
}

/**
 * The index of the chosen view, which an edit of the file may have moved; else the first table view,
 * as the core picks it. Null without a view.
 */
function shownView(views: BaseView[], chosen: BaseChoice["view"]): number | null {
  if (chosen) {
    if (views[chosen.index]?.name === chosen.name) return chosen.index;
    const named = views.findIndex((v) => v.name === chosen.name);
    if (chosen.name !== null && named >= 0) return named;
  }
  if (!views.length) return null;
  return Math.max(
    views.findIndex((v) => v.type === "table"),
    0,
  );
}

/** The index of the view called `name`, else of one that differs in case only; null without one. */
function namedView(views: BaseView[], name: string): number | null {
  let index = views.findIndex((v) => v.name === name);
  if (index < 0) index = views.findIndex((v) => v.name?.toLowerCase() === name.toLowerCase());
  return index < 0 ? null : index;
}

function groupRow(label: string, group: BaseGroup, index: number): ViewRow {
  return {
    key: `group ${index}`,
    group: { label, value: cellText(group.value) || "No value", count: group.rows },
    cells: [],
    path: "",
    title: "",
    properties: [],
    cover: null,
  };
}

/** `rowNote` is the note of the row when the cell is its name. */
function viewCell(cell: BaseCell, rowNote: string | null): ViewCell {
  const link = cell.type === "link" ? (cell.value as BaseLink) : null;
  // Only notes open in a tab; a link to another file or to no file is text.
  const linked = link?.path && isMarkdownPath(link.path) ? link.path : null;
  return {
    text: cellText(cell),
    checked: cell.type === "checkbox" ? cell.value === true : null,
    note: rowNote ?? linked,
    url: link?.url ?? null,
    failed: cell.type === "error",
    edit: null,
  };
}

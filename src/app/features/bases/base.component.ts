import { Component, computed, effect, inject, signal, untracked } from "@angular/core";
import type { HxColumn, HxLazyLoadEvent } from "@gravionlabs/helix-ui";
import { HxDataTable, HxSelectButton, HxTableBody } from "@gravionlabs/helix-ui";
import { openUrl } from "@tauri-apps/plugin-opener";

import type { BaseCell, BaseGroup, BaseLink, BaseResult, BaseView } from "../../core/file/backend";
import { backend } from "../../core/file/backend";
import { IndexService } from "../../core/index/index.service";
import { basename, isMarkdownPath, joinPath } from "../../core/markdown/paths";
import { SettingsService } from "../../core/settings/settings.service";
import type { BaseChoice } from "../../core/tabs/tabs.service";
import { CURRENT_TAB, TabsService } from "../../core/tabs/tabs.service";
import { WorkspaceService } from "../../core/workspace/workspace.service";
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
}

/** A row of the table: a note, or the heading of a group. */
interface ViewRow {
  key: string;
  /** Set for the heading of a group. */
  group: { label: string; value: string; count: number } | null;
  cells: ViewCell[];
}

/** The table tab of a `.base` file: the core reads the file's view from the index. */
@Component({
  selector: "app-base",
  imports: [HxDataTable, HxSelectButton, HxTableBody],
  templateUrl: "./base.component.html",
  styleUrl: "./base.component.css",
})
export class BaseComponent {
  private readonly tab = inject(CURRENT_TAB);
  private readonly index = inject(IndexService);
  private readonly settings = inject(SettingsService);
  private readonly tabs = inject(TabsService);
  private readonly workspace = inject(WorkspaceService);

  protected readonly name = computed(() => basename(this.tab.base() ?? ""));
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
    const sort = this.tab.baseChoice().sort;
    const column = this.result()?.columns.findIndex((c) => c.id === sort?.property) ?? -1;
    return column < 0 ? null : `c${column}`;
  });
  protected readonly sortOrder = computed(() =>
    this.tab.baseChoice().sort?.direction === "DESC" ? -1 : 1,
  );
  protected readonly rows = computed<ViewRow[]>(() => {
    const result = this.result();
    if (!result) return [];
    const rows: ViewRow[] = result.rows.map((row) => ({
      key: `note ${row.path}`,
      group: null,
      cells: row.cells.map((cell, i) =>
        viewCell(cell, result.columns[i]?.id === FILE_NAME ? row.path : null),
      ),
    }));
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
      this.tab.base(),
      JSON.stringify(this.tab.baseChoice()),
      this.workspace.vaultRoot(),
      this.index.status().state,
      this.index.revision(),
    ].join("\n"),
  );
  /** Counts the queries: only the answer of the newest one is shown. */
  private request = 0;
  private shown: string | null = null;

  constructor() {
    effect(() => {
      this.key();
      untracked(() => void this.refresh());
    });
  }

  private async refresh(): Promise<void> {
    const request = ++this.request;
    const path = this.tab.base();
    // The table of another file is not shown while this one is read.
    if (path !== this.shown) {
      this.result.set(null);
      this.error.set(null);
      this.views.set([]);
      this.active.set(null);
      this.shown = path;
    }
    if (path === null) return;
    // Only the notes of the vault are indexed here: a base of another root would list the wrong ones.
    const root = this.workspace.vaultRoot();
    if (root === null || !path.startsWith(`${root.replace(/\/$/, "")}/`)) {
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
    try {
      const source = await backend.readTextFile(path);
      if (request !== this.request) return;
      const views = await backend.baseViews(source);
      if (request !== this.request) return;
      const { view, sort } = this.tab.baseChoice();
      const index = shownView(views, view);
      this.views.set(views);
      this.active.set(index);
      const result = await backend.baseQuery(source, index, sort);
      if (request !== this.request) return;
      this.result.set(result);
      this.error.set(null);
    } catch (err) {
      // The command log has the failure already (`loggedInvoke`).
      if (request !== this.request) return;
      this.result.set(null);
      this.error.set(String(err));
    }
  }

  /** Shows another view in this tab, with its own sort. */
  protected show(index: number): void {
    const view = this.views()[index];
    if (!view || index === this.active()) return;
    // The table of the view before is not shown while this one is read.
    this.result.set(null);
    this.error.set(null);
    this.tab.baseChoice.set({ view: { index, name: view.name }, sort: null });
  }

  /** A click on a column header: ascending, descending, then the sort of the view again. */
  protected sortBy({ sortField, sortOrder }: HxLazyLoadEvent): void {
    const column = this.columns().findIndex((c) => c.field === sortField);
    const property = this.result()?.columns[column]?.id;
    this.tab.baseChoice.update((choice) => ({
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

function groupRow(label: string, group: BaseGroup, index: number): ViewRow {
  return {
    key: `group ${index}`,
    group: { label, value: cellText(group.value) || "No value", count: group.rows },
    cells: [],
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
  };
}

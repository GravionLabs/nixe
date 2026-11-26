import { Component, DestroyRef, computed, effect, inject, signal, untracked } from "@angular/core";
import type { HxColumn } from "@gravionlabs/helix-ui";
import {
  HxButton,
  HxDataTable,
  HxSelect,
  HxSelectButton,
  HxTableBody,
} from "@gravionlabs/helix-ui";
import { openUrl } from "@tauri-apps/plugin-opener";

import type { BaseResult } from "../../core/file/backend";
import { backend } from "../../core/file/backend";
import { NoteEditService } from "../../core/file/note-edit.service";
import { IndexService } from "../../core/index/index.service";
import { joinPath } from "../../core/markdown/paths";
import { SettingsService } from "../../core/settings/settings.service";
import { TabsService } from "../../core/tabs/tabs.service";
import { FolderRolesService } from "../../core/workspace/folder-roles.service";
import { WorkspaceService } from "../../core/workspace/workspace.service";
import { coverImage } from "../bases/cover-image";
import {
  DEFAULT_LINKS_FOLDER,
  collections,
  filterLinks,
  linkItems,
  linkTags,
  type LinkItem,
  type LinkStatus,
} from "./link-list";
import base from "./links-base.json";
import { LinksViewService } from "./links-view.service";

/** The base that lists the link notes. */
const SOURCE = JSON.stringify(base);

/** A status that was set here and that the shown result does not hold yet. */
interface Marked {
  status: LinkStatus;
  /** The writes that are under way. */
  pending: number;
}

/**
 * The Links tab: the `type: link` notes of the vault as cards or a table, with the inbox of the
 * unread ones. The core answers the list from the index, like a base.
 */
@Component({
  selector: "app-links",
  imports: [HxButton, HxDataTable, HxSelect, HxSelectButton, HxTableBody],
  templateUrl: "./links.component.html",
  styleUrl: "./links.component.css",
})
export class LinksComponent {
  protected readonly view = inject(LinksViewService);
  private readonly index = inject(IndexService);
  private readonly notes = inject(NoteEditService);
  private readonly roles = inject(FolderRolesService);
  private readonly settings = inject(SettingsService);
  private readonly tabs = inject(TabsService);
  private readonly workspace = inject(WorkspaceService);

  protected readonly tabOptions = [
    { value: "unread", label: "Unread" },
    { value: "all", label: "All" },
  ];
  protected readonly layoutOptions = [
    { value: "cards", label: "Cards" },
    { value: "table", label: "Table" },
  ];
  protected readonly statusOptions = filterOptions(["unread", "read"]);
  protected readonly columns: HxColumn[] = [
    { field: "title", header: "Title" },
    { field: "site", header: "Site" },
    { field: "tags", header: "Tags" },
    { field: "saved", header: "Saved" },
    { field: "status", header: "Status" },
  ];

  /** The last answered list; null while loading and after a failure. */
  private readonly result = signal<BaseResult | null>(null);
  protected readonly error = signal<string | null>(null);
  /** By the path of the note. */
  private readonly marked = signal<ReadonlyMap<string, Marked>>(new Map());
  /** The addresses of the cover images that could not be loaded. */
  private readonly failed = signal<ReadonlySet<string>>(new Set());

  /** Null while there is no answer. */
  protected readonly links = computed<LinkItem[] | null>(() => {
    const result = this.result();
    if (!result) return null;
    const folder = this.roles.roles().find((r) => r.role === "links")?.path ?? DEFAULT_LINKS_FOLDER;
    const marked = this.marked();
    return linkItems(result, folder).map((link) => {
      const change = marked.get(link.path);
      return change ? { ...link, status: change.status } : link;
    });
  });
  protected readonly collections = computed(() => collections(this.links() ?? []));
  protected readonly tags = computed(() => linkTags(this.links() ?? []));
  protected readonly collectionOptions = computed(() => filterOptions(this.collections()));
  protected readonly tagFilterOptions = computed(() => filterOptions(this.tags()));
  /** The chosen collection and tag, as long as a link has them. */
  protected readonly collection = computed(() => known(this.view.collection(), this.collections()));
  protected readonly tag = computed(() => known(this.view.tag(), this.tags()));
  protected readonly shown = computed(() =>
    filterLinks(this.links() ?? [], {
      collection: this.collection(),
      tag: this.tag(),
      status: this.view.tab() === "unread" ? "unread" : this.view.status(),
    }),
  );

  private readonly key = computed(() =>
    [this.workspace.vaultRoot(), this.index.status().state, this.index.revision()].join("\n"),
  );
  /** Counts the queries: only the answer of the newest one is shown. */
  private request = 0;
  private root: string | null = null;

  constructor() {
    inject(DestroyRef).onDestroy(() => this.request++);
    effect(() => {
      this.key();
      untracked(() => void this.refresh());
    });
  }

  private async refresh(): Promise<void> {
    const request = ++this.request;
    const root = this.workspace.vaultRoot();
    if (root !== this.root) {
      this.result.set(null);
      this.marked.set(new Map());
      this.root = root;
    }
    if (root === null) {
      this.result.set(null);
      this.error.set("Open a vault to see its links.");
      return;
    }
    const state = this.index.status().state;
    if (state !== "ready") {
      this.result.set(null);
      this.error.set(state === "error" ? "The vault index is not available." : null);
      return;
    }
    try {
      const result = await backend.baseQuery(SOURCE);
      if (request !== this.request) return;
      this.failed.set(new Set());
      this.result.set(result);
      // The result holds the stored values; those still being written stay as set.
      this.marked.update((marked) => new Map([...marked].filter(([, m]) => m.pending > 0)));
      this.error.set(null);
    } catch (err) {
      // The command log has the failure already (`loggedInvoke`).
      if (request !== this.request) return;
      this.result.set(null);
      this.error.set(String(err));
    }
  }

  /**
   * Marks the link read or unread in the frontmatter of its note. The new status shows at once;
   * when it cannot be stored, the old one comes back with the reason.
   */
  protected async toggle(link: LinkItem): Promise<void> {
    const root = this.workspace.vaultRoot();
    if (!root) return;
    const status: LinkStatus = link.status === "read" ? "unread" : "read";
    const before = this.marked().get(link.path);
    this.mark(link.path, { status, pending: (before?.pending ?? 0) + 1 });
    try {
      await this.notes.editProperty(joinPath(root, link.path), "status", () => status);
      const now = this.marked().get(link.path);
      if (now) this.mark(link.path, { ...now, pending: now.pending - 1 });
    } catch (err) {
      const now = this.marked().get(link.path);
      if (now && now.pending > 1) this.mark(link.path, { ...now, pending: now.pending - 1 });
      else this.mark(link.path, before && !before.pending ? before : null);
      const reason = err instanceof Error ? err.message : String(err);
      const message = `${link.title} was not marked ${status}: ${reason}`;
      console.error(message);
      this.tabs.notice.set(message);
    }
  }

  private mark(path: string, value: Marked | null): void {
    this.marked.update((marked) => {
      const next = new Map(marked);
      if (value) next.set(path, value);
      else next.delete(path);
      return next;
    });
  }

  /** A click opens the note in a tab; with Ctrl or Cmd it opens the page in the system browser. */
  protected async open(link: LinkItem, event: MouseEvent): Promise<void> {
    const external = event.ctrlKey || event.metaKey;
    const root = this.workspace.vaultRoot();
    try {
      if (external) {
        if (link.url) await openUrl(link.url);
        else this.tabs.notice.set(`${link.title} has no web address.`);
      } else if (root) {
        const path = joinPath(root, link.path);
        if (this.settings.previewTabs()) await this.tabs.openPreview(path);
        else await this.tabs.openInNewTab(path);
      }
    } catch (err) {
      // Opening switches the tab, so this component may be gone: the notice goes to the app.
      this.tabs.notice.set(String(err));
    }
  }

  protected image(link: LinkItem): string | null {
    const image = coverImage(link.cover, this.workspace.vaultRoot());
    return image && !this.failed().has(image) ? image : null;
  }

  protected imageFailed(image: string): void {
    this.failed.update((failed) => new Set(failed).add(image));
  }

  /** The empty value of the "All" option stands for no filter. */
  protected chosen(value: string | null): string | null {
    return value || null;
  }

  protected chooseStatus(value: string | null): void {
    this.view.status.set(value === "read" || value === "unread" ? value : null);
  }
}

/** The options of a filter: "All" with the empty value, then the values as they are. */
function filterOptions(values: readonly string[]): { value: string; label: string }[] {
  return [{ value: "", label: "All" }, ...values.map((value) => ({ value, label: value }))];
}

function known(value: string | null, options: readonly string[]): string | null {
  return value !== null && options.includes(value) ? value : null;
}

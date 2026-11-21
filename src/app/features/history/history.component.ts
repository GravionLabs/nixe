import { Component, computed, inject, signal } from "@angular/core";

import type { DiffRow } from "../../core/git/line-diff";
import { diffLines, diffStat } from "../../core/git/line-diff";
import type { TimelineEntry } from "../../core/git/history.service";
import { HistoryService } from "../../core/git/history.service";
import { WorkspaceService } from "../../core/workspace/workspace.service";
import { MarkdownService } from "../../core/markdown/markdown.service";
import { EmptyStateComponent } from "../../shared/panel/empty-state.component";
import { NoteRowComponent } from "../../shared/panel/note-row.component";
import { PanelSectionComponent } from "../../shared/panel/panel-section.component";

/** `YYYY-MM-DD HH:MM` in UTC. */
export function formatCommitTime(secs: number): string {
  return new Date(secs * 1000).toISOString().slice(0, 16).replace("T", " ");
}

/** Sidebar: the timeline of the open note and the difference between the selected versions. */
@Component({
  selector: "app-history",
  imports: [PanelSectionComponent, NoteRowComponent, EmptyStateComponent],
  templateUrl: "./history.component.html",
  styleUrl: "./history.component.css",
})
export class HistoryComponent {
  protected readonly history = inject(HistoryService);
  private readonly markdown = inject(MarkdownService);
  private readonly workspace = inject(WorkspaceService);

  protected readonly mode = signal<"source" | "rendered">("source");

  protected readonly rows = computed<DiffRow[]>(() => {
    const c = this.history.comparison();
    return c ? diffLines(c.oldText, c.newText) : [];
  });
  protected readonly stat = computed(() => diffStat(this.rows()));

  protected readonly rendered = computed(() => {
    const c = this.history.comparison();
    if (!c) return null;
    const ctx = {
      filePath: null,
      wikiRoot: null,
      math: false,
      vaultRoot: this.workspace.vaultRoot(),
    };
    return { old: this.markdown.render(c.oldText, ctx), new: this.markdown.render(c.newText, ctx) };
  });

  protected time(entry: TimelineEntry): string {
    return entry.id === null ? "now" : formatCommitTime(entry.time);
  }

  protected selected(entry: TimelineEntry): boolean {
    return this.history.selection().includes(entry.id ?? "");
  }

  /** Copies the selected text of the diff or rendered versions, else the whole version. */
  protected async copy(entry: TimelineEntry): Promise<void> {
    const part = window.getSelection()?.toString() ?? "";
    const text = part !== "" ? part : await this.history.versionText(entry);
    await navigator.clipboard.writeText(text);
    this.history.notice.set(part !== "" ? "Copied the selection" : "Copied the version");
  }

  /** Older entries load when the list is scrolled near its end. */
  protected onScroll(list: HTMLElement): void {
    if (list.scrollHeight - list.scrollTop - list.clientHeight < 80) void this.history.loadMore();
  }
}

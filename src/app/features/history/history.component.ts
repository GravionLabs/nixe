import { Component, computed, inject, signal } from "@angular/core";

import { diffLines, diffStat } from "../../core/git/line-diff";
import type { TimelineEntry } from "../../core/git/history.service";
import { HistoryService } from "../../core/git/history.service";
import { DiffComponent } from "../../shared/diff/diff.component";
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
  imports: [DiffComponent, PanelSectionComponent, NoteRowComponent, EmptyStateComponent],
  templateUrl: "./history.component.html",
  styleUrl: "./history.component.css",
})
export class HistoryComponent {
  protected readonly history = inject(HistoryService);

  protected readonly mode = signal<"source" | "rendered">("source");

  protected readonly stat = computed(() => {
    const c = this.history.comparison();
    return diffStat(c ? diffLines(c.oldText, c.newText) : []);
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

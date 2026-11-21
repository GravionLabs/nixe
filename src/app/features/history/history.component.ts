import type { OnDestroy } from "@angular/core";
import { Component, computed, inject, signal, viewChild } from "@angular/core";
import type { HxMenuItem } from "@gravionlabs/helix-ui";
import { HxMenu } from "@gravionlabs/helix-ui";

import { diffLines, diffStat } from "../../core/git/line-diff";
import type { TimelineEntry } from "../../core/git/history.service";
import { HistoryService } from "../../core/git/history.service";
import { DiffComponent } from "../../shared/diff/diff.component";
import { EmptyStateComponent } from "../../shared/panel/empty-state.component";
import { NoteRowComponent } from "../../shared/panel/note-row.component";
import { noteLabel } from "../../shared/panel/note-label";
import { PanelSectionComponent } from "../../shared/panel/panel-section.component";
import {
  describeEntry,
  exactTime,
  groupByDay,
  hasSeveralAuthors,
  relativeTime,
} from "./timeline-format";

/** `YYYY-MM-DD HH:MM` in UTC. */
export function formatCommitTime(secs: number): string {
  return new Date(secs * 1000).toISOString().slice(0, 16).replace("T", " ");
}

/** Sidebar: the timeline of the open note and the difference between the selected versions. */
@Component({
  selector: "app-history",
  imports: [DiffComponent, PanelSectionComponent, NoteRowComponent, EmptyStateComponent, HxMenu],
  templateUrl: "./history.component.html",
  styleUrl: "./history.component.css",
})
export class HistoryComponent implements OnDestroy {
  protected readonly history = inject(HistoryService);

  protected readonly mode = signal<"source" | "rendered">("source");

  protected readonly stat = computed(() => {
    const c = this.history.comparison();
    return diffStat(c ? diffLines(c.oldText, c.newText) : []);
  });

  /** The clock of the relative times; ticks once a minute. */
  protected readonly now = signal(Date.now());
  private readonly tick = setInterval(() => this.now.set(Date.now()), 60_000);

  protected readonly label = computed(() => {
    const path = this.history.notePath();
    return path === null ? null : noteLabel(path);
  });

  protected readonly groups = computed(() => groupByDay(this.history.timeline(), this.now()));
  protected readonly showAuthor = computed(() => hasSeveralAuthors(this.history.timeline()));

  /** The entry the context menu was opened on. */
  protected readonly menuEntry = signal<TimelineEntry | null>(null);
  private readonly contextMenu = viewChild<HxMenu>("contextMenu");
  protected readonly menuItems = computed<HxMenuItem[]>(() => {
    const entry = this.menuEntry();
    if (entry === null) return [];
    return [
      { label: "Restore this version", command: () => void this.history.restore(entry) },
      { label: "Copy content", command: () => void this.copy(entry) },
    ];
  });

  ngOnDestroy(): void {
    clearInterval(this.tick);
  }

  protected describe = describeEntry;
  protected relative(entry: TimelineEntry): string {
    return relativeTime(entry.time, this.now());
  }
  protected exact(entry: TimelineEntry): string {
    return exactTime(entry.time);
  }

  /** Right click on a commit opens the menu with its actions. */
  protected openMenu(event: MouseEvent, entry: TimelineEntry): void {
    if (entry.id === null) return;
    event.preventDefault();
    this.menuEntry.set(entry);
    this.contextMenu()?.showAt(
      { x: event.clientX, y: event.clientY },
      event.currentTarget as Element | null,
    );
  }

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

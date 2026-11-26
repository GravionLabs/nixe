import type { OnDestroy } from "@angular/core";
import { Component, computed, inject, signal, viewChild } from "@angular/core";
import type { HxMenuItem } from "@gravionlabs/helix-ui";
import { HxList, HxListRow, HxMenu } from "@gravionlabs/helix-ui";

import type { DeletedNote, RecentNote } from "../../core/file/backend";
import type { TimelineEntry } from "../../core/git/history.service";
import { HistoryService } from "../../core/git/history.service";
import { EmptyStateComponent } from "../../shared/panel/empty-state.component";
import { NoteRowComponent } from "../../shared/panel/note-row.component";
import { NoteTitleComponent } from "../../shared/panel/note-title.component";
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

/** Sidebar: the timeline of the open note, the recently changed notes without one, the trash; the versions are compared in the main area (#324). */
@Component({
  selector: "app-history",
  imports: [
    PanelSectionComponent,
    NoteRowComponent,
    NoteTitleComponent,
    HxList,
    HxListRow,
    EmptyStateComponent,
    HxMenu,
  ],
  templateUrl: "./history.component.html",
  styleUrl: "./history.component.css",
})
export class HistoryComponent implements OnDestroy {
  protected readonly history = inject(HistoryService);

  /** The version "Compare with…" was chosen on; the next click picks the second one. */
  protected readonly pickFrom = signal<TimelineEntry | null>(null);

  /** The clock of the relative times; ticks once a minute. */
  protected readonly now = signal(Date.now());
  private readonly tick = setInterval(() => this.now.set(Date.now()), 60_000);

  protected readonly label = computed(() => {
    const path = this.history.notePath();
    return path === null ? null : noteLabel(path);
  });

  /** The filter of the trash: matches title and folder. */
  protected readonly filter = signal("");
  protected readonly trash = computed(() => {
    const q = this.filter().trim().toLowerCase();
    if (q === "") return this.history.deleted();
    return this.history.deleted().filter((n) => n.path.toLowerCase().includes(q));
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
      {
        label: "Compare with current version",
        command: () => void this.history.compareWithCurrent(entry),
      },
      { label: "Compare with…", command: () => this.pickFrom.set(entry) },
      { label: "Restore this version", command: () => void this.history.reviewRestore(entry) },
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
  protected exact(entry: { time: number }): string {
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

  protected deletedAgo(note: DeletedNote): string {
    return `deleted ${relativeTime(note.time, this.now())}`;
  }
  protected changedAgo(note: RecentNote): string {
    return relativeTime(note.time, this.now());
  }

  protected time(entry: TimelineEntry): string {
    return entry.id === null ? "now" : formatCommitTime(entry.time);
  }

  /** A click on a version opens its change, or completes a "Compare with…". */
  protected activate(entry: TimelineEntry): void {
    const first = this.pickFrom();
    if (first === null) {
      void this.history.open(entry);
      return;
    }
    this.pickFrom.set(null);
    if (first !== entry) void this.history.compareBetween(first, entry);
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

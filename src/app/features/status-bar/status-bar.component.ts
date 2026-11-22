import { Component, computed, effect, inject, signal, untracked } from "@angular/core";
import {
  HxStatusBar,
  HxStatusItem,
  HxStatusPopover,
  HxStatusVersion,
  HxStatusZoom,
  getHxPlatform,
  getHxPlatformKind,
} from "@gravionlabs/helix-desktop";
import { HxTooltip } from "@gravionlabs/helix-ui";

import { DocumentService } from "../../core/file/document.service";
import { EditorService } from "../../core/editor/editor.service";
import { readingTime } from "../../core/editor/text-stats";
import { CommandRegistry } from "../../core/commands/command-registry";
import { ShortcutService } from "../../core/commands/shortcut.service";
import { BacklinksService } from "../../core/index/backlinks.service";
import { ChangesService } from "../../core/git/changes.service";
import { GitService } from "../../core/git/git.service";
import { ReviewService } from "../../core/git/review.service";
import { SettingsService, ZOOM_MAX, ZOOM_MIN } from "../../core/settings/settings.service";
import { ShellService } from "../../core/shell/shell.service";
import { isPrerelease } from "../../core/updater/update-logic";
import { UpdateService } from "../../core/updater/update.service";

/**
 * Bottom bar, always visible on desktop: Git at the start (only in a repository), zoom, version, update
 * state and the shortcuts at the end. Another item is one more `hx-status-item` in a slot; nothing else
 * changes. On iOS the bar is not rendered; the version is on the settings page.
 */
@Component({
  selector: "app-status-bar",
  imports: [HxStatusBar, HxStatusItem, HxStatusPopover, HxStatusVersion, HxStatusZoom, HxTooltip],
  templateUrl: "./status-bar.component.html",
  styles: `
    :host {
      display: block;
    }

    .details .notes {
      max-height: 12rem;
      overflow: auto;
      white-space: pre-wrap;
    }
  `,
})
export class StatusBarComponent {
  protected readonly shortcuts = inject(ShortcutService);
  protected readonly git = inject(GitService);
  protected readonly changes = inject(ChangesService);
  protected readonly review = inject(ReviewService);
  protected readonly shell = inject(ShellService);
  protected readonly settings = inject(SettingsService);
  protected readonly updater = inject(UpdateService);
  protected readonly commands = inject(CommandRegistry);
  protected readonly editor = inject(EditorService);
  protected readonly doc = inject(DocumentService);
  protected readonly links = inject(BacklinksService);
  protected readonly readingTime = readingTime;

  protected readonly zoomMin = ZOOM_MIN;
  protected readonly zoomMax = ZOOM_MAX;
  /** The bar is for the desktop shell; iOS has none. */
  protected readonly shown = getHxPlatformKind(getHxPlatform()) !== "mobile";
  /** An RC build is not offered an update. */
  protected readonly rc = computed(() => isPrerelease(this.updater.version()));

  /** The update popover; it closes with the `available` phase so no empty frame stays. */
  protected readonly updateOpen = signal(false);

  protected readonly interactive = computed(() => {
    const phase = this.updater.phase();
    return phase !== "checking" && phase !== "installing";
  });

  protected readonly tone = computed(() => {
    const phase = this.updater.phase();
    return phase === "available" ? "accent" : phase === "error" ? "error" : "neutral";
  });

  constructor() {
    effect(() => {
      if (this.updater.phase() !== "available") this.updateOpen.set(false);
    });
    // The links panel reads the lists only while it is mounted; the count in the bar must follow the index too.
    effect(() => {
      this.links.key();
      untracked(() => void this.links.refresh());
    });
  }

  /** Opens the list of the notes the last pull changed. */
  protected showPulled(): void {
    void this.changes.showSync();
    this.shell.show("git");
  }

  /** Opens the Git view, which lists the suggestions waiting for review. */
  protected showReview(): void {
    this.shell.show("git");
  }

  /** The item checks (idle, up to date) or retries (error); `available` opens its popover instead. */
  protected onUpdateClick(): void {
    const phase = this.updater.phase();
    if (phase === "error") this.retry();
    else if (phase === "idle" || phase === "up-to-date") void this.updater.check();
  }

  /** Retries the step that failed: the install when an update is known, else the check. */
  protected retry(): void {
    if (this.updater.update()) void this.updater.install();
    else void this.updater.check();
  }
}

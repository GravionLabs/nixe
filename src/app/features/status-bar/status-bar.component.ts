import { Component, effect, inject, untracked } from "@angular/core";
import {
  HxStatusBar,
  HxStatusItem,
  HxStatusZoom,
  getHxPlatform,
  getHxPlatformKind,
} from "@gravionlabs/helix-desktop";
import { HxStatusAppVersion, HxStatusUpdate } from "@gravionlabs/helix-desktop/tauri";
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

/**
 * Bottom bar, always visible on desktop: Git at the start (only in a repository), zoom, version, update
 * state and the shortcuts at the end. Another item is one more `hx-status-item` in a slot; nothing else
 * changes. On iOS the bar is not rendered; the version is on the settings page.
 */
@Component({
  selector: "app-status-bar",
  imports: [HxStatusBar, HxStatusItem, HxStatusZoom, HxStatusAppVersion, HxStatusUpdate, HxTooltip],
  templateUrl: "./status-bar.component.html",
  styles: `
    :host {
      display: block;
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
  protected readonly commands = inject(CommandRegistry);
  protected readonly editor = inject(EditorService);
  protected readonly doc = inject(DocumentService);
  protected readonly links = inject(BacklinksService);
  protected readonly readingTime = readingTime;

  protected readonly zoomMin = ZOOM_MIN;
  protected readonly zoomMax = ZOOM_MAX;
  /** The bar is for the desktop shell; iOS has none. */
  protected readonly shown = getHxPlatformKind(getHxPlatform()) !== "mobile";

  constructor() {
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
}

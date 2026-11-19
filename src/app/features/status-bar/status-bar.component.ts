import { Component, computed, inject } from "@angular/core";
import { HxStatusBar, HxStatusItem, HxStatusPopover, HxStatusVersion, HxStatusZoom, getHxPlatform, getHxPlatformKind } from "@gravionlabs/helix-desktop";

import { CommandRegistry } from "../../core/commands/command-registry";
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
  imports: [HxStatusBar, HxStatusItem, HxStatusPopover, HxStatusVersion, HxStatusZoom],
  template: `
    @if (shown) {
      <hx-status-bar>
        @if (git.status(); as status) {
          <ng-container ngProjectAs="[slot=start]">
          <hx-status-item
            slot="start"
            kind="button"
            class="git"
            [ariaLabel]="'Git: ' + (status.branch ?? 'detached HEAD')"
            title="Show the Git changes"
            (click)="shell.show('git')"
          >
            <span class="branch">⎇ {{ status.branch ?? "detached HEAD" }}</span>
            <span class="changes">{{ status.changes.length }} changed</span>
            <span class="sync">↑{{ status.ahead }} ↓{{ status.behind }}</span>
          </hx-status-item>
          <hx-status-item
            slot="start"
            kind="button"
            class="sync-button"
            ariaLabel="Sync with the remote"
            title="Commit, pull with rebase and push"
            [disabled]="git.syncState().phase === 'syncing'"
            (click)="git.sync()"
          >
            ⟳ Sync
          </hx-status-item>
          @if (changes.pulled().length; as n) {
            <hx-status-item
              slot="start"
              kind="button"
              class="pulled"
              title="Show what the last sync brought"
              (click)="showPulled()"
            >
              {{ n }} {{ n === 1 ? "note" : "notes" }} changed
            </hx-status-item>
          }
          @if (review.count(); as n) {
            <hx-status-item
              slot="start"
              kind="button"
              class="review"
              title="Branches waiting for review"
              (click)="showReview()"
            >
              {{ n }} {{ n === 1 ? "branch" : "branches" }} to review
            </hx-status-item>
          }
          @if (git.syncState().message; as message) {
            <hx-status-item slot="start" class="result" [announce]="true" [tone]="git.syncState().phase === 'error' ? 'error' : 'neutral'">{{ message }}</hx-status-item>
          }
          </ng-container>
        }

        <hx-status-zoom slot="end" [value]="settings.zoom()" (valueChange)="settings.zoom.set($event)" [min]="zoomMin" [max]="zoomMax" [step]="10" [reset]="100" />
        @if (updater.version(); as version) {
          <hx-status-version slot="end" [version]="version" [channel]="rc() ? 'RC' : null" />
        }
        @if (!rc()) {
          <hx-status-item
            slot="end"
            class="update"
            [kind]="interactive() ? 'button' : 'text'"
            [tone]="tone()"
            [announce]="updater.phase() === 'checking' || updater.phase() === 'installing' || updater.phase() === 'error'"
            [title]="updater.phase() === 'error' ? updater.error() : 'Check for updates'"
            [ariaLabel]="updater.phase() === 'available' ? 'Update details' : null"
            (click)="onUpdateClick()"
          >
            @switch (updater.phase()) {
              @case ("checking") {
                Checking for updates…
              }
              @case ("installing") {
                Installing…@if (updater.percent(); as percent) { {{ percent }}% }
              }
              @case ("available") {
                Update {{ updater.update()?.version }}
              }
              @case ("error") {
                {{ updater.update() ? "Update failed, retry" : "Update check failed, retry" }}
              }
              @case ("up-to-date") {
                Up to date
              }
              @default {
                Check for updates
              }
            }
            @if (updater.phase() === "available") {
            <div hxStatusPopover class="details">
              <p>Nixe {{ updater.update()?.version }} is available (you have {{ updater.version() }}).</p>
              @if (updater.update()?.body; as notes) {
                <pre class="notes" aria-label="Release notes">{{ notes }}</pre>
              }
              <button type="button" class="install" (click)="updater.install()">Install and restart</button>
            </div>
            }
          </hx-status-item>
        }
        <hx-status-item slot="end" kind="button" class="shortcuts" ariaLabel="Shortcuts" title="Shortcuts and commands" (click)="commands.execute('command-palette')">?</hx-status-item>
      </hx-status-bar>
    }
  `,
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
  protected readonly git = inject(GitService);
  protected readonly changes = inject(ChangesService);
  protected readonly review = inject(ReviewService);
  protected readonly shell = inject(ShellService);
  protected readonly settings = inject(SettingsService);
  protected readonly updater = inject(UpdateService);
  protected readonly commands = inject(CommandRegistry);

  protected readonly zoomMin = ZOOM_MIN;
  protected readonly zoomMax = ZOOM_MAX;
  /** The bar is for the desktop shell; iOS has none. */
  protected readonly shown = getHxPlatformKind(getHxPlatform()) !== "mobile";
  /** An RC build is not offered an update. */
  protected readonly rc = computed(() => isPrerelease(this.updater.version()));

  protected readonly interactive = computed(() => {
    const phase = this.updater.phase();
    return phase !== "checking" && phase !== "installing";
  });

  protected readonly tone = computed(() => {
    const phase = this.updater.phase();
    return phase === "available" ? "accent" : phase === "error" ? "error" : "neutral";
  });

  /** Opens the list of the notes the last pull changed. */
  protected showPulled(): void {
    void this.changes.showSync();
    this.shell.show("git");
  }

  /** Opens the Git view, which lists the branches waiting for review. */
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

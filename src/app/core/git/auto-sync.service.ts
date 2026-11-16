import { DOCUMENT } from "@angular/common";
import { Injectable, effect, inject } from "@angular/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

import { SettingsService } from "../settings/settings.service";
import { AUTO_SYNC_IDLE_MS, AutoSyncScheduler } from "./auto-sync";
import { GitService } from "./git.service";

/** Longest the app waits for the sync on quit before it closes anyway. */
const QUIT_TIMEOUT_MS = 15_000;

/** Runs `GitService.sync` on an interval and on focus, when the editor is idle; and on quit. */
@Injectable({ providedIn: "root" })
export class AutoSyncService {
  private readonly git = inject(GitService);
  private readonly settings = inject(SettingsService);
  private readonly document = inject(DOCUMENT);
  private readonly scheduler = new AutoSyncScheduler(() => this.git.sync({ auto: true }), AUTO_SYNC_IDLE_MS);

  constructor() {
    effect(() => {
      const on = this.settings.autoSync() && this.git.available();
      const minutes = this.settings.autoSyncMinutes();
      if (on) this.scheduler.start(minutes * 60_000);
      else this.scheduler.stop();
    });
    for (const type of ["keydown", "input", "pointerdown"]) {
      this.document.addEventListener(type, () => this.scheduler.activity(), true);
    }
  }

  /** The window got focus. */
  onFocus(): void {
    if (this.settings.autoSync() && this.settings.autoSyncOnFocus() && this.git.available()) this.scheduler.request();
  }

  /** Syncs once before the window closes (without waiting for idle). Never throws. */
  async onQuit(): Promise<void> {
    if (!this.settings.autoSync() || !this.settings.autoSyncOnQuit() || !this.git.available()) return;
    const done = (async () => {
      // A sync that is already running finishes first; `sync` ignores a second call.
      while (this.git.syncState().phase === "syncing") await new Promise((resolve) => setTimeout(resolve, 100));
      await this.git.sync({ auto: true });
    })();
    await Promise.race([done, new Promise((resolve) => setTimeout(resolve, QUIT_TIMEOUT_MS))]);
  }

  /** Hooks the window events of the desktop app. */
  async listenWindow(): Promise<void> {
    const win = getCurrentWindow();
    await win.onFocusChanged((e) => {
      if (e.payload) this.onFocus();
    });
    await win.onCloseRequested(async (event) => {
      if (!this.settings.autoSync() || !this.settings.autoSyncOnQuit() || !this.git.available()) return;
      event.preventDefault();
      await this.onQuit();
      await win.destroy();
    });
  }
}

import { Injectable, inject, signal } from "@angular/core";
import { revealItemInDir } from "@tauri-apps/plugin-opener";

import { backend } from "../file/backend";
import { TabsService } from "../tabs/tabs.service";
import { COPY_LOG_LINES } from "./log-level";
import type { LogLevel } from "./log-level";

/** The log commands (#412): show the log in a tab, copy its end, open its folder, set its level. */
@Injectable({ providedIn: "root" })
export class LogActionsService {
  private readonly tabs = inject(TabsService);

  /** The folder of `nixe.log`; empty until known or without a log file. */
  readonly folder = signal("");

  /** Opens `nixe.log` as a read-only text in a tab. */
  show(): void {
    this.tabs.openView("log");
  }

  /** Puts the last lines of the log on the clipboard for a bug report. */
  async copy(): Promise<void> {
    try {
      const text = await backend.logRead(COPY_LOG_LINES);
      if (text === "") {
        this.tabs.notice.set("The log is empty.");
        return;
      }
      await navigator.clipboard.writeText(text);
      const count = text.split("\n").length;
      this.tabs.notice.set(`Copied the last ${count} lines of the log.`);
    } catch (err) {
      this.tabs.notice.set(`Copy failed: ${String(err)}`);
    }
  }

  /** Shows `nixe.log` in the file manager. */
  async reveal(): Promise<void> {
    try {
      await revealItemInDir(await backend.logPath());
    } catch (err) {
      this.tabs.notice.set(`Could not open the log folder: ${String(err)}`);
    }
  }

  /** Reads the folder of the log for the settings page and the About text. */
  async loadFolder(): Promise<void> {
    try {
      this.folder.set(folderOf(await backend.logPath()));
    } catch {
      // No log file (a browser, a mobile build): the settings page names none.
    }
  }

  /** Applies the level at once; the Rust core logs the change. */
  async setLevel(level: LogLevel): Promise<void> {
    try {
      await backend.logSetLevel(level);
    } catch {
      // Without Tauri there is nothing to change.
    }
  }
}

/** The directory of a file path, with either kind of separator. */
export function folderOf(path: string): string {
  const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return cut > 0 ? path.slice(0, cut) : path;
}

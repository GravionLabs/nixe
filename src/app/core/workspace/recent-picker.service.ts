import { Injectable, inject, signal } from "@angular/core";

import { SettingsService } from "../settings/settings.service";
import { WorkspaceService } from "./workspace.service";

/** The message shown when a vault of the recent list no longer exists. */
export function missingMessage(paths: readonly string[]): string {
  return paths.length === 1
    ? `The vault ${paths[0]} no longer exists and was removed from the recent vaults.`
    : `${paths.length} vaults no longer exist and were removed from the recent vaults: ${paths.join(", ")}`;
}

/** `File → Open recent`: the last vaults, listed by the palette. */
@Injectable({ providedIn: "root" })
export class RecentPickerService {
  private readonly settings = inject(SettingsService);
  private readonly workspace = inject(WorkspaceService);

  readonly vaults = this.settings.recentVaults;
  /** Set when vaults were dropped from the list; the app shows it as a message. */
  readonly notice = signal<string | null>(null);

  /** Removes the vaults whose folder is gone from the list and says so in `notice`. */
  async prune(): Promise<void> {
    const missing = await this.workspace.pruneMissingRecent();
    if (missing.length) this.notice.set(missingMessage(missing));
  }

  /** Opens the vault; a vault that is gone is removed with a message. */
  async choose(path: string): Promise<void> {
    if (!(await this.workspace.openRecent(path))) this.notice.set(missingMessage([path]));
  }
}

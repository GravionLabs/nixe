import { Injectable, inject, signal } from "@angular/core";

import { SettingsService } from "../settings/settings.service";
import { WorkspaceService } from "./workspace.service";

/** The message shown when a vault of the recent list no longer exists. */
export function missingMessage(paths: readonly string[]): string {
  return paths.length === 1
    ? `The vault ${paths[0]} no longer exists and was removed from the recent vaults.`
    : `${paths.length} vaults no longer exist and were removed from the recent vaults: ${paths.join(", ")}`;
}

/** `File → Open recent`: the picker of the last vaults. */
@Injectable({ providedIn: "root" })
export class RecentPickerService {
  private readonly settings = inject(SettingsService);
  private readonly workspace = inject(WorkspaceService);

  readonly visible = signal(false);
  readonly selected = signal(0);
  readonly vaults = this.settings.recentVaults;
  /** Set when vaults were dropped from the list; the app shows it as a message. */
  readonly notice = signal<string | null>(null);

  /** Opens the picker after removing the vaults whose folder is gone. */
  async open(): Promise<void> {
    const missing = await this.workspace.pruneMissingRecent();
    if (missing.length) this.notice.set(missingMessage(missing));
    this.selected.set(0);
    this.visible.set(true);
  }

  close(): void {
    this.visible.set(false);
  }

  move(delta: number): void {
    const n = this.vaults().length;
    if (n) this.selected.update((i) => (i + delta + n) % n);
  }

  current(): string | null {
    return this.vaults()[this.selected()] ?? null;
  }

  /** Closes the picker and opens the vault; a vault that is gone is removed with a message. */
  async choose(path: string): Promise<void> {
    this.close();
    if (!(await this.workspace.openRecent(path))) this.notice.set(missingMessage([path]));
  }
}

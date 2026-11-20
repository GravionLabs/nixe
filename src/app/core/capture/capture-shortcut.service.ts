import { Injectable, effect, inject, signal, untracked } from "@angular/core";

import { backend } from "../file/backend";
import { SettingsService } from "../settings/settings.service";

/**
 * Tells the backend to register the global shortcut again when the setting changes (#118). At
 * startup the backend registers the saved shortcut itself, so the first value is not applied.
 */
@Injectable({ providedIn: "root" })
export class CaptureShortcutService {
  private readonly settings = inject(SettingsService);
  /** Why the last registration failed (an invalid shortcut); null when it worked. */
  readonly error = signal<string | null>(null);
  private previous = this.settings.captureShortcut();

  constructor() {
    effect(() => {
      const shortcut = this.settings.captureShortcut();
      untracked(() => void this.apply(shortcut));
    });
  }

  private async apply(shortcut: string): Promise<void> {
    if (shortcut === this.previous) return;
    this.previous = shortcut;
    try {
      // The backend reads the settings file, so the write must have finished.
      await this.settings.flush();
      await backend.captureApply();
      this.error.set(null);
    } catch (err) {
      this.error.set(String(err));
    }
  }
}

import { Injectable, computed, inject, signal } from "@angular/core";

import { HealthReport, backend } from "../file/backend";
import { SettingsService } from "../settings/settings.service";
import { IndexService } from "./index.service";

export type HealthState = "idle" | "loading" | "error" | "ready";

/** The vault health report (broken links, orphans, duplicates, unused attachments). */
@Injectable({ providedIn: "root" })
export class HealthService {
  private readonly index = inject(IndexService);
  private readonly settings = inject(SettingsService);

  readonly report = signal<HealthReport | null>(null);
  private readonly failed = signal(false);
  private request = 0;

  readonly state = computed<HealthState>(() => {
    const status = this.index.status().state;
    if (status === "error" || this.failed()) return "error";
    if (status !== "ready") return "loading";
    return this.report() ? "ready" : "idle";
  });

  /** Changes whenever the report must be computed again: index updates, excluded folders. */
  readonly key = computed(
    () =>
      `${this.index.status().state}|${this.index.revision()}|${this.settings.healthExclude().join("\n")}`,
  );

  /** Sets the excluded folders from a comma or line separated list. */
  setExcluded(text: string): void {
    const folders = text
      .split(/[,\n]/)
      .map((f) => f.trim().replace(/^\.?\/+|\/+$/g, ""))
      .filter(Boolean);
    this.settings.healthExclude.set([...new Set(folders)]);
  }

  /** A newer call wins over an older one still running. */
  async refresh(): Promise<void> {
    const request = ++this.request;
    if (this.index.status().state !== "ready") {
      this.report.set(null);
      this.failed.set(false);
      return;
    }
    try {
      const report = await backend.vaultHealth(this.settings.healthExclude());
      if (request !== this.request) return;
      this.report.set(report);
      this.failed.set(false);
    } catch {
      if (request !== this.request) return;
      this.report.set(null);
      this.failed.set(true);
    }
  }
}

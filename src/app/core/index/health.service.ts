import { Injectable, computed, inject, signal } from "@angular/core";

import type { DeadLink, HealthReport } from "../file/backend";
import { backend } from "../file/backend";
import { SettingsService } from "../settings/settings.service";
import { IndexService } from "./index.service";

export type HealthState = "idle" | "loading" | "error" | "ready";

/** The vault health report (broken links, orphans, duplicates, unused attachments). */
@Injectable({ providedIn: "root" })
export class HealthService {
  private readonly index = inject(IndexService);
  private readonly settings = inject(SettingsService);

  readonly report = signal<HealthReport | null>(null);
  /** Dead links of the last "Check links" run; null before one ran. */
  readonly deadLinks = signal<DeadLink[] | null>(null);
  readonly checkingLinks = signal(false);
  readonly linkCheckFailed = signal(false);
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

  /** Opt-in: requests the address of every link note of the vault at `root`. */
  async checkLinks(root: string, force = false): Promise<void> {
    if (this.checkingLinks()) return;
    this.checkingLinks.set(true);
    this.linkCheckFailed.set(false);
    try {
      this.deadLinks.set(await backend.checkDeadLinks(root, this.settings.healthExclude(), force));
    } catch {
      this.linkCheckFailed.set(true);
    } finally {
      this.checkingLinks.set(false);
    }
  }
}

import { Injectable, computed, inject, signal } from "@angular/core";
import { getVersion } from "@tauri-apps/api/app";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, Update } from "@tauri-apps/plugin-updater";

import { EditorService } from "../editor/editor.service";
import { UpdateStep, downloadPercent, failureMessage, isOfferable } from "./update-logic";

export type UpdatePhase = "idle" | "checking" | "up-to-date" | "available" | "installing" | "error";

/** Checks for a new version only on request, and installs it after the user confirms. */
@Injectable({ providedIn: "root" })
export class UpdateService {
  private readonly editor = inject(EditorService);

  /** The running version; empty until known. */
  readonly version = signal("");
  readonly phase = signal<UpdatePhase>("idle");
  /** The offered update; kept after a failed install so it can be retried. */
  readonly update = signal<Update | null>(null);
  readonly error = signal("");
  readonly failedStep = signal<UpdateStep | null>(null);
  private readonly received = signal(0);
  private readonly total = signal<number | null>(null);
  readonly percent = computed(() => downloadPercent(this.received(), this.total()));
  readonly busy = computed(() => this.phase() === "checking" || this.phase() === "installing");

  /** Reads the running version (no network). */
  async init(): Promise<void> {
    try {
      this.version.set(await getVersion());
    } catch {
      // not running inside Tauri
    }
  }

  /** The menu entry and the status bar: asks the update endpoint once. */
  async check(): Promise<void> {
    if (this.busy()) return;
    this.error.set("");
    this.failedStep.set(null);
    this.phase.set("checking");
    try {
      if (!this.version()) await this.init();
      const found = await check();
      if (found && isOfferable(this.version(), found.version)) {
        this.update.set(found);
        this.phase.set("available");
      } else {
        this.update.set(null);
        this.phase.set("up-to-date");
      }
    } catch (err) {
      this.fail("check", err);
    }
  }

  /** Saves the editor, downloads and verifies the package, installs it and restarts. */
  async install(): Promise<void> {
    const update = this.update();
    if (!update || this.busy()) return;
    this.error.set("");
    this.failedStep.set(null);
    this.received.set(0);
    this.total.set(null);
    this.phase.set("installing");
    try {
      // Windows quits the app when the installer starts, so the text is saved first.
      await this.editor.handle?.flush();
      // `flush` swallows a failed write and writes nothing while a conflict is open.
      if (this.editor.handle?.dirty()) throw new Error("the open note could not be saved");
      await update.downloadAndInstall((event) => {
        if (event.event === "Started") this.total.set(event.data.contentLength ?? null);
        else if (event.event === "Progress")
          this.received.update((n) => n + event.data.chunkLength);
      });
      await relaunch();
    } catch (err) {
      this.fail("update", err);
    }
  }

  private fail(step: UpdateStep, err: unknown): void {
    this.failedStep.set(step);
    this.error.set(failureMessage(step, err));
    // After a failed install the update stays available for the retry.
    this.phase.set("error");
  }
}

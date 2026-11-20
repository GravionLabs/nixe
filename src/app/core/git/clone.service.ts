import { Injectable, computed, inject, signal } from "@angular/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";

import type { CloneProgress } from "../file/backend";
import { CLONE_CANCELLED, CLONE_PROGRESS_EVENT, backend } from "../file/backend";
import { WorkspaceService } from "../workspace/workspace.service";
import { GitService } from "./git.service";

/** True for the `https://github.com/...` urls the backend can clone and send the token to. */
export function isCloneUrl(url: string): boolean {
  return /^https:\/\/github\.com\/[^\s@]+$/.test(url.trim());
}

/** "Clone vault": asks for a URL and a folder, clones with progress and opens the new vault. */
@Injectable({ providedIn: "root" })
export class CloneService {
  private readonly git = inject(GitService);
  private readonly workspace = inject(WorkspaceService);

  readonly visible = signal(false);
  readonly url = signal("");
  /** The folder the repository is cloned into (as a subfolder named after it). */
  readonly parent = signal("");
  readonly cloning = signal(false);
  readonly progress = signal<CloneProgress | null>(null);
  readonly error = signal("");

  readonly percent = computed(() => {
    const p = this.progress();
    return p && p.total > 0 ? Math.min(100, Math.floor((p.received * 100) / p.total)) : null;
  });
  readonly canStart = computed(
    () => !this.cloning() && isCloneUrl(this.url()) && this.parent() !== "",
  );

  open(): void {
    if (this.cloning()) return;
    this.error.set("");
    this.progress.set(null);
    this.visible.set(true);
  }

  /** Closes the dialog; a running clone is cancelled. */
  async close(): Promise<void> {
    await this.cancel();
    this.visible.set(false);
  }

  async chooseFolder(): Promise<void> {
    const selected = await open({ directory: true, multiple: false });
    if (typeof selected === "string") this.parent.set(selected);
  }

  /** Stops the running clone (the backend removes the partial folder) and any open token prompt. */
  async cancel(): Promise<void> {
    if (!this.cloning()) return;
    this.git.cancelTokenPrompt();
    await backend.gitCloneCancel().catch(() => undefined);
  }

  /** Clones and opens the vault. Never throws: the outcome is in `error` and `visible`. */
  async start(): Promise<void> {
    if (!this.canStart()) return;
    const url = this.url().trim();
    const parent = this.parent();
    this.cloning.set(true);
    this.error.set("");
    this.progress.set(null);
    let unlisten: (() => void) | undefined;
    try {
      unlisten = await listen<CloneProgress>(CLONE_PROGRESS_EVENT, (e) =>
        this.progress.set(e.payload),
      );
    } catch {
      // No progress without events; the clone itself still works.
    }
    try {
      const dest = await this.git.runRemote(() => backend.gitCloneVault(url, parent));
      await this.workspace.openFolder(dest);
      this.visible.set(false);
    } catch (err) {
      const text = String(err instanceof Error ? err.message : err).replace(/^Error: /, "");
      this.error.set(
        text === CLONE_CANCELLED
          ? "Clone cancelled"
          : /^auth-(required|failed):/.test(text)
            ? "GitHub needs a valid access token"
            : `Clone failed: ${text}`,
      );
    } finally {
      unlisten?.();
      this.cloning.set(false);
    }
  }
}
